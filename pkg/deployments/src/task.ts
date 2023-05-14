import fs from 'fs';
import path, { extname } from 'path';
import { BuildInfo, CompilerOutputContract, HardhatRuntimeEnvironment } from 'hardhat/types';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import logger from './logger';
import Verifier from './verifier';
import { deploy, instanceAt } from './contracts';

import {
  NETWORKS,
  Network,
  Libraries,
  Artifact,
  Input,
  Output,
  Param,
  RawInputKeyValue,
  RawOutput,
  TaskRunOptions,
} from './types';

const TASKS_DIRECTORY = path.resolve(__dirname, '../tasks');

export enum TaskMode {
  LIVE, // Deploys and saves outputs
  TEST, // Deploys but saves to test output
  CHECK, // Checks past deployments on deploy
  READ_ONLY, // Fails on deploy
}

/* eslint-disable @typescript-eslint/no-var-requires */

export default class Task {
  id: string;
  mode: TaskMode;

  _network?: Network;
  _verifier?: Verifier;
  _outputFile?: string;

  constructor(idAlias: string, mode: TaskMode, network?: Network, verifier?: Verifier) {
    if (network && !NETWORKS.includes(network)) throw Error(`Unknown network ${network}`);
    this.id = this._findTaskId(idAlias);
    this.mode = mode;
    this._network = network;
    this._verifier = verifier;
  }

  get outputFile(): string {
    return `${this._outputFile || this.network}.json`;
  }

  set outputFile(file: string) {
    this._outputFile = file;
  }

  get network(): string {
    if (!this._network) throw Error('A network must be specified to define a task');
    return this._network;
  }

  set network(name: Network) {
    this._network = name;
  }

  async instanceAt(name: string, address: string): Promise<Contract> {
    return instanceAt(this.artifact(name), address);
  }

  async deployedInstance(name: string): Promise<Contract> {
    const address = this.output()[name];
    if (!address) throw Error(`Could not find deployed address for ${name}`);
    return this.instanceAt(name, address);
  }

  async inputInstance(artifactName: string, inputName: string): Promise<Contract> {
    const rawInput = this.rawInput();
    const input = rawInput[inputName];
    if (!this._isTask(input)) throw Error(`Cannot access to non-task input ${inputName}`);
    const task = input as Task;
    task.network = this.network;
    const address = this._parseRawInput(rawInput)[inputName];
    return task.instanceAt(artifactName, address);
  }

  async deployAndVerify(
    name: string,
    args: Array<Param> = [],
    from?: SignerWithAddress,
    force?: boolean,
    libs?: Libraries
  ): Promise<Contract> {
    const output = this.output({ ensure: false });
    if (force || !output[name]) {
      const instance = await this.deploy(name, args, from);
      this.save({ [name]: instance });
      await this.verify(name, instance.address, args, libs);
      return instance;
    } else {
      logger.info(`${name} already deployed at ${output[name]}`);
      await this.verify(name, output[name], args, libs);
      return this.instanceAt(name, output[name]);
    }
  }

  // async deployAndVerify(
  //   name: string,
  //   args: Array<Param> = [],
  //   from?: SignerWithAddress,
  //   force?: boolean,
  //   libs?: Libraries
  // ): Promise<Contract> {
  //   if (this.mode == TaskMode.CHECK) {
  //     return await this.check(name, args, libs);
  //   }

  //   const instance = await this.deploy(name, args, from, force, libs);

  //   await this.verify(name, instance.address, args, libs);
  //   return instance;
  // }

  async deploy(
    name: string,
    args: Array<Param> = [],
    from?: SignerWithAddress,
    force?: boolean,
    libs?: Libraries
  ): Promise<Contract> {
    // if (this.mode == TaskMode.CHECK) {
    //   return await this.check(name, args, libs);
    // }

    if (this.mode !== TaskMode.LIVE && this.mode !== TaskMode.TEST) {
      throw Error(`Cannot deploy in tasks of mode ${TaskMode[this.mode]}`);
    }

    let instance: Contract;
    const output = this.output({ ensure: false });
    if (force || !output[name]) {
      instance = await deploy(this.artifact(name), args, from, libs);
      this.save({ [name]: instance });
      logger.success(`Deployed ${name} at ${instance.address}`);

      if (this.mode === TaskMode.LIVE) {
        console.log(`"${instance.address}":"${instance.deployTransaction.hash}"`);
        // saveContractDeploymentTransactionHash(instance.address, instance.deployTransaction.hash, this.network);
      }
    } else {
      logger.info(`${name} already deployed at ${output[name]}`);
      instance = await this.instanceAt(name, output[name]);
    }

    return instance;
  }

  async verify(
    name: string,
    address: string,
    constructorArguments: string | unknown[],
    libs?: Libraries
  ): Promise<void> {
    if (this.mode !== TaskMode.LIVE) {
      return;
    }

    try {
      if (!this._verifier) return logger.warn('Skipping contract verification, no verifier defined');
      const url = await this._verifier.call(this, name, address, constructorArguments, libs);
      logger.success(`Verified contract ${name} at ${url}`);
    } catch (error) {
      logger.error(`Failed trying to verify ${name} at ${address}: ${error}`);
    }
  }

  async run(options: TaskRunOptions = {}): Promise<void> {
    const taskPath = this._fileAt(this.dir(), 'index.ts');
    const task = require(taskPath).default;
    await task(this, options);
  }

  // async check(name: string, args: Array<Param> = [], libs?: Libraries): Promise<Contract> {
  //   // There's multiple approaches to checking that a deployed contract matches known source code. A naive approach is
  //   // to check for a match in the runtime code, but that doesn't account for actions taken during  construction,
  //   // including calls, storage writes and setting immutable state variables. Since immutable state variables modify the
  //   // runtime code, it can be actually quite tricky to produce a matching runtime code.
  //   // What we do instead is check for both runtime code and constrcutor execution (including constructor arguments) by
  //   // looking at the transaction in which the contract was deployed. The data of said transaction will be the contract
  //   // creation code followed by the abi-encoded constructor arguments, which we can compare against what the task would
  //   // attempt to deploy. In this way, we are testing the task's build info, inputs and deployment code.
  //   // The only thing we're not checking is what account deployed the contract, but our code does not have dependencies
  //   // on the deployer.

  //   // The only problem with the approach described above is that it is not easy to find the transaction in which a
  //   // contract is deployed. Tenderly has a dedicated endpoint for this however.

  //   const { ethers } = await import('hardhat');

  //   const deployedAddress = this.output()[name];
  //   const deploymentTxHash = getContractDeploymentTransactionHash(deployedAddress, this.network);
  //   const deploymentTx = await ethers.provider.getTransaction(deploymentTxHash);

  //   const expectedDeploymentAddress = getContractAddress(deploymentTx);
  //   if (deployedAddress !== expectedDeploymentAddress) {
  //     throw Error(
  //       `The stated deployment address of '${name}' on network '${this.network}' of task '${this.id}' (${deployedAddress}) does not match the address which would be deployed by the transaction ${deploymentTxHash} (which instead deploys to ${expectedDeploymentAddress})`
  //     );
  //   }

  //   const expectedDeploymentTxData = await deploymentTxData(this.artifact(name), args, libs);
  //   if (deploymentTx.data === expectedDeploymentTxData) {
  //     logger.success(`Verified contract '${name}' on network '${this.network}' of task '${this.id}'`);
  //   } else {
  //     throw Error(
  //       `The build info and inputs for contract '${name}' on network '${this.network}' of task '${this.id}' does not match the data used to deploy address ${deployedAddress}`
  //     );
  //   }

  //   // We need to return an instance so that the task may carry on, potentially using this as input of future
  //   // deployments.
  //   return this.instanceAt(name, deployedAddress);
  // }

  dir(): string {
    if (!this.id) throw Error('Please provide a task deployment ID to run');
    return this._dirAt(TASKS_DIRECTORY, this.id);
  }

  buildInfo(fileName: string): BuildInfo {
    const buildInfoDir = this._dirAt(this.dir(), 'build-info');
    const artifactFile = this._fileAt(buildInfoDir, `${extname(fileName) ? fileName : `${fileName}.json`}`);
    return JSON.parse(fs.readFileSync(artifactFile).toString());
  }

  buildInfos(): Array<BuildInfo> {
    const buildInfoDir = this._dirAt(this.dir(), 'build-info');
    return fs.readdirSync(buildInfoDir).map((fileName) => this.buildInfo(fileName));
  }

  artifact(contractName: string, fileName?: string): Artifact {
    const buildInfoDir = this._dirAt(this.dir(), 'build-info');
    const builds: {
      [sourceName: string]: { [contractName: string]: CompilerOutputContract };
    } = this._existsFile(path.join(buildInfoDir, `${fileName || contractName}.json`))
      ? this.buildInfo(contractName).output.contracts
      : this.buildInfos().reduce((result, info: BuildInfo) => ({ ...result, ...info.output.contracts }), {});

    const sourceName = Object.keys(builds).find((sourceName) =>
      Object.keys(builds[sourceName]).find((key) => key === contractName)
    );

    if (!sourceName) throw Error(`Could not find artifact for ${contractName}`);
    return builds[sourceName][contractName];
  }

  rawInput(): RawInputKeyValue {
    const taskInputPath = this._fileAt(this.dir(), 'input.ts');
    const rawInput = require(taskInputPath).default;
    const globalInput = { ...rawInput };
    NETWORKS.forEach((network) => delete globalInput[network]);
    const networkInput = rawInput[this.network] || {};
    return { ...globalInput, ...networkInput };
  }

  input(): Input {
    return this._parseRawInput(this.rawInput());
  }

  output({ ensure = true, network }: { ensure?: boolean; network?: Network } = {}): Output {
    if (network) this.network = network;
    const taskOutputDir = this._dirAt(this.dir(), 'output', ensure);
    const taskOutputFile = this._fileAt(taskOutputDir, this.outputFile, ensure);
    return this._read(taskOutputFile);
  }

  save(output: RawOutput): void {
    const taskOutputDir = this._dirAt(this.dir(), 'output', false);
    if (!fs.existsSync(taskOutputDir)) fs.mkdirSync(taskOutputDir);

    const taskOutputFile = this._fileAt(taskOutputDir, this.outputFile, false);
    const previousOutput = this._read(taskOutputFile);

    const finalOutput = { ...previousOutput, ...this._parseRawOutput(output) };
    this._write(taskOutputFile, finalOutput);
  }

  delete(): void {
    const taskOutputDir = this._dirAt(this.dir(), 'output');
    const taskOutputFile = this._fileAt(taskOutputDir, this.outputFile);
    fs.unlinkSync(taskOutputFile);
  }

  private _parseRawInput(rawInput: RawInputKeyValue): Input {
    return Object.keys(rawInput).reduce((input: Input, key: Network | string) => {
      const item = rawInput[key];
      if (Array.isArray(item)) input[key] = item;
      else if (BigNumber.isBigNumber(item)) input[key] = item;
      else if (typeof item !== 'object') input[key] = item;
      else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output: Output | any = this._isTask(item) ? (item as Task).output({ network: this.network }) : item;
        input[key] = output[key] ? output[key] : output;
      }
      return input;
    }, {});
  }

  private _parseRawOutput(rawOutput: RawOutput): Output {
    return Object.keys(rawOutput).reduce((output: Output, key: string) => {
      const value = rawOutput[key];
      output[key] = typeof value === 'string' ? value : value.address;
      return output;
    }, {});
  }

  private _read(path: string): Output {
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path).toString()) : {};
  }

  private _write(path: string, output: Output): void {
    const timestamp = new Date().getTime();
    const finalOutputJSON = JSON.stringify({ ...output, timestamp }, null, 2);
    fs.writeFileSync(path, finalOutputJSON);
  }

  private _fileAt(base: string, name: string, ensure = true): string {
    const filePath = path.join(base, name);
    if (ensure && !this._existsFile(filePath)) throw Error(`Could not find a file at ${filePath}`);
    return filePath;
  }

  private _dirAt(base: string, name: string, ensure = true): string {
    const dirPath = path.join(base, name);
    if (ensure && !this._existsDir(dirPath)) throw Error(`Could not find a directory at ${dirPath}`);
    return dirPath;
  }

  private _existsFile(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  }

  private _existsDir(dirPath: string): boolean {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isTask(object: any): boolean {
    return object.constructor.name == 'Task';
  }

  private _findTaskId(idAlias: string): string {
    const matches = Task.getAllTaskIds().filter((taskDirName) => taskDirName.includes(idAlias));

    if (matches.length == 1) {
      return matches[0];
    } else {
      if (matches.length == 0) {
        throw Error(`Found no matching directory for task alias '${idAlias}'`);
      } else {
        throw Error(
          `Multiple matching directories for task alias '${idAlias}', candidates are: \n${matches.join('\n')}`
        );
      }
    }
  }

  static getAllTaskIds(): string[] {
    return [TASKS_DIRECTORY]
      .map((dir) => fs.readdirSync(dir))
      .flat()
      .sort();
  }
}
