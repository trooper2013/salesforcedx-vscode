/*
 * Copyright (c) 2019, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { CliCommandExecutor, Command, SfdxCommandBuilder } from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as fs from 'fs';
import { componentUtil } from 'lightning-lsp-common';
import * as vscode from 'vscode';
import { nls } from '../messages';
import { DevServerService } from '../service/devServerService';
import { DEV_SERVER_PREVIEW_ROUTE } from './commandConstants';
import { openBrowser, showError } from './commandUtils';
import { ForceLightningLwcStartExecutor, PlatformType } from './forceLightningLwcStart';

const sfdxCoreExports = vscode.extensions.getExtension(
  'salesforce.salesforcedx-vscode-core'
)!.exports;

const {
  SfdxCommandlet,
  telemetryService,
  EmptyParametersGatherer,
  SfdxWorkspaceChecker
} = sfdxCoreExports;

const logName = 'force_lightning_lwc_preview';
const commandName = nls.localize('force_lightning_lwc_preview_text');
const SfdxCommandletExecutor = sfdxCoreExports.SfdxCommandletExecutor;

export enum PreviewPlatformType {
  Desktop = 1,
  iOS,
  Android
}

interface PreviewQuickPickItem extends vscode.QuickPickItem {
    id: PreviewPlatformType;
    defaultTargetName: string;
}

const platformInput: PreviewQuickPickItem[] = [
  { label: 'Use Desktop Browser', detail: 'Preview Component On Desktop Browser', alwaysShow: true, picked: true, id: PreviewPlatformType.Desktop, defaultTargetName: ''},
  { label: 'Use iOS Simulator', detail: 'Preview Component On iOS', alwaysShow: true, picked: false, id: PreviewPlatformType.iOS, defaultTargetName: 'SFDXSimulator'},
  { label: 'Use Android Emulator', detail: 'Preview Component On Android', alwaysShow: true, picked: false, id: PreviewPlatformType.Android, defaultTargetName: 'SFDXEmulator'}

];

export async function forceLightningLwcPreview(sourceUri: vscode.Uri) {

  const startTime = process.hrtime();
  if (!sourceUri) {
    const message = nls.localize(
      'force_lightning_lwc_preview_file_undefined',
      sourceUri
    );
    showError(new Error(message), logName, commandName);
    return;
  }

  const resourcePath = sourceUri.path;
  if (!resourcePath) {
    const message = nls.localize(
      'force_lightning_lwc_preview_file_undefined',
      resourcePath
    );
    showError(new Error(message), logName, commandName);
    return;
  }

  if (!fs.existsSync(resourcePath)) {
    const message = nls.localize(
      'force_lightning_lwc_preview_file_nonexist',
      resourcePath
    );
    showError(new Error(message), logName, commandName);
    return;
  }

  const isSFDX = true; // TODO support non SFDX projects
  const isDirectory = fs.lstatSync(resourcePath).isDirectory();
  const componentName = isDirectory
    ? componentUtil.moduleFromDirectory(resourcePath, isSFDX)
    : componentUtil.moduleFromFile(resourcePath, isSFDX);

  if (!componentName) {
    const message = nls.localize(
      'force_lightning_lwc_preview_unsupported',
      resourcePath
    );
    showError(new Error(message), logName, commandName);
    return;
  }

  const platFormSelection = await vscode.window.showQuickPick(platformInput, {
    placeHolder: 'Select the platform to preview the component?'
  });

  if ( !platFormSelection ) {
    console.log(`${logName}: No valid selection made for preview...`);
    return;
  }

  const fullUrl = `${DEV_SERVER_PREVIEW_ROUTE}/${componentName}`;

  if (platFormSelection.id === PreviewPlatformType.Desktop) {
    await handleDesktop(fullUrl, startTime);
  } else {
    let targetName = await vscode.window.showInputBox({
      placeHolder: 'Enter or Select the name for the target here. Leave Blank for Default.'
    });

    if (!targetName) {
      targetName = platFormSelection.defaultTargetName;
    }

    if (platFormSelection.id === PreviewPlatformType.iOS) {
      await handleiOS(fullUrl, startTime, targetName);
    } else if (platFormSelection.id === PreviewPlatformType.Android) {
      await handleAndroid(fullUrl, startTime, targetName);
    }

  }

}

async function handleDesktop(fullUrl: string, startTime: [number, number]) {
  if (DevServerService.instance.isServerHandlerRegistered()) {
    try {
      await openBrowser(fullUrl);
      telemetryService.sendCommandEvent(logName, startTime);
    } catch (e) {
      showError(e, logName, commandName);
    }
  } else {
      console.log(`${logName}: server was not running, starting...`);
      const preconditionChecker = new SfdxWorkspaceChecker();
      const parameterGatherer = new EmptyParametersGatherer();
      const executor = new ForceLightningLwcStartExecutor({
        openBrowser: true,
        fullUrl,
        platform: PlatformType.Desktop
      });

      const commandlet = new SfdxCommandlet(
        preconditionChecker,
        parameterGatherer,
        executor
      );

      await commandlet.run();
      telemetryService.sendCommandEvent(logName, startTime);
  }
}

async function handleiOS(fullUrl: string, startTime: [number, number], targetName: string) {
  console.log(`${logName}: server was not running, starting...`);
  const command = new SfdxCommandBuilder()
                    .withDescription(commandName)
                    .withArg('force:lightning:lwc:preview')
                    .withFlag('-p', 'iOS')
                    .withFlag('-t', targetName)
                    .withFlag('-f', fullUrl != null ? fullUrl : '')
                    .build();

  const cancellationTokenSource = new vscode.CancellationTokenSource();
  const cancellationToken = cancellationTokenSource.token;

  const executor = new CliCommandExecutor(command, {
    env: { SFDX_JSON_TO_STDOUT: 'true' }
  });
  executor.execute(cancellationToken);
}

async function handleAndroid(fullUrl: string, startTime: [number, number], targetName: string) {
  console.log(`${logName}: server was not running, starting...`);
  const command = new SfdxCommandBuilder()
                    .withDescription(commandName)
                    .withArg('force:lightning:lwc:preview')
                    .withFlag('-p', 'Android')
                    .withFlag('-t', targetName)
                    .withFlag('-f', fullUrl != null ? fullUrl : '')
                    .build();

  const cancellationTokenSource = new vscode.CancellationTokenSource();
  const cancellationToken = cancellationTokenSource.token;

  const executor = new CliCommandExecutor(command, {
    env: { SFDX_JSON_TO_STDOUT: 'true' }
  });
  executor.execute(cancellationToken);
}

export class MobileLwcStartExecutor extends SfdxCommandletExecutor<{}> {
  private readonly platformType: PreviewPlatformType;
  private readonly targetName: string;

  constructor(platformType: PreviewPlatformType =  PreviewPlatformType.Desktop, targetName: string) {
    super();
    this.platformType = platformType;
    this.targetName = targetName;
  }

  public build(): Command {
    let command =  new SfdxCommandBuilder()
                    .withDescription(commandName)
                    .withArg('force:lightning:lwc:start')
                    .withLogName(logName)
                    // .withJson()
                    .build();

    if (this.platformType === PreviewPlatformType.iOS) {
        command = new SfdxCommandBuilder()
                    .withDescription(commandName)
                    .withArg('force:lightning:lwc:preview')
                    .withFlag('-p', 'iOS')
                    .withFlag('-t', 'SFDXSimulator')
                    .withFlag('-f', this.options.fullUrl != null ? this.options.fullUrl : '')
                    .build();

    } else if (this.platformType === PreviewPlatformType.Android) {
       command = new SfdxCommandBuilder()
                    .withDescription(commandName)
                    .withArg('force:lightning:lwc:preview')
                    .withFlag('-p', 'Android')
                    .withFlag('-t', 'SFDXEmulator')
                    .withFlag('-f',  this.options.fullUrl != null ? this.options.fullUrl : '')
                    .build();
    }

    return command;
  }

  public execute(response: ContinueResponse<{}>): void {

    const startTime = process.hrtime();
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;

    const executor = new CliCommandExecutor(this.build(), {
      cwd: this.executionCwd,
      env: { SFDX_JSON_TO_STDOUT: 'true' }
    });
    const execution = executor.execute(cancellationToken);
    const executionName = execution.command.toString();
  }
}
