/*
 * Copyright (c) 2019, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import {
  CancelResponse,
  ContinueResponse,
  LocalComponent,
  PostconditionChecker
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { existsSync } from 'fs';
import { join } from 'path';
import { channelService } from '../../channels';
import { ConflictDetectionConfig, conflictDetector } from '../../conflict';
import { nls } from '../../messages';
import { notificationService } from '../../notifications';
import { sfdxCoreSettings } from '../../settings';
import { SfdxPackageDirectories } from '../../sfdxProject';
import { telemetryService } from '../../telemetry';
import { getRootWorkspacePath, OrgAuthInfo } from '../../util';
import { MetadataDictionary } from '../../util/metadataDictionary';
import { PathStrategyFactory } from './sourcePathStrategies';

type OneOrMany = LocalComponent | LocalComponent[];
type ContinueOrCancel = ContinueResponse<OneOrMany> | CancelResponse;

export class EmptyPostChecker implements PostconditionChecker<any> {
  public async check(
    inputs: ContinueResponse<any> | CancelResponse
  ): Promise<ContinueResponse<any> | CancelResponse> {
    return inputs;
  }
}

/* tslint:disable-next-line:prefer-for-of */
export class OverwriteComponentPrompt
  implements PostconditionChecker<OneOrMany> {
  public async check(inputs: ContinueOrCancel): Promise<ContinueOrCancel> {
    if (inputs.type === 'CONTINUE') {
      const { data } = inputs;
      // normalize data into a list when processing
      const componentsToCheck = data instanceof Array ? data : [data];
      const foundComponents = componentsToCheck.filter(component =>
        this.componentExists(component)
      );
      if (foundComponents.length > 0) {
        const toSkip = await this.promptOverwrite(foundComponents);
        // cancel command if cancel clicked or if skipping every file to be retrieved
        if (!toSkip || toSkip.size === componentsToCheck.length) {
          return { type: 'CANCEL' };
        }
        if (data instanceof Array) {
          inputs.data = componentsToCheck.filter(
            selection => !toSkip.has(selection)
          );
        }
      }
      return inputs;
    }
    return { type: 'CANCEL' };
  }

  private componentExists(component: LocalComponent) {
    const { fileName, type, outputdir } = component;
    const info = MetadataDictionary.getInfo(type);
    const pathStrategy = info
      ? info.pathStrategy
      : PathStrategyFactory.createDefaultStrategy();
    return this.getFileExtensions(component).some(extension => {
      const path = join(
        getRootWorkspacePath(),
        pathStrategy.getPathToSource(outputdir, fileName, extension)
      );
      return existsSync(path);
    });
  }

  private getFileExtensions(component: LocalComponent) {
    const info = MetadataDictionary.getInfo(component.type);
    let metadataSuffix;
    if (component.suffix) {
      metadataSuffix = component.suffix;
    } else if (info && info.suffix) {
      metadataSuffix = info.suffix;
    } else {
      notificationService.showErrorMessage(
        nls.localize('error_overwrite_prompt')
      );
      telemetryService.sendException(
        'OverwriteComponentPromptException',
        `Missing suffix for ${component.type}`
      );
    }
    const extensions = [`.${metadataSuffix}-meta.xml`];
    if (info && info.extensions) {
      extensions.push(...info.extensions);
    }
    return extensions;
  }

  public async promptOverwrite(
    foundComponents: LocalComponent[]
  ): Promise<Set<LocalComponent> | undefined> {
    const skipped = new Set<LocalComponent>();
    for (let i = 0; i < foundComponents.length; i++) {
      const options = this.buildDialogOptions(foundComponents, skipped, i);
      const choice = await notificationService.showWarningModal(
        this.buildDialogMessage(foundComponents, i),
        ...options
      );
      const othersCount = foundComponents.length - i;
      switch (choice) {
        case nls.localize('warning_prompt_overwrite'):
          break;
        case nls.localize('warning_prompt_skip'):
          skipped.add(foundComponents[i]);
          break;
        case `${nls.localize('warning_prompt_overwrite_all')} (${othersCount})`:
          return skipped;
        case `${nls.localize('warning_prompt_skip_all')} (${othersCount})`:
          return new Set(foundComponents.slice(i));
        default:
          return; // Cancel
      }
    }
    return skipped;
  }

  private buildDialogMessage(
    foundComponents: LocalComponent[],
    currentIndex: number
  ) {
    const existingLength = foundComponents.length;
    const current = foundComponents[currentIndex];
    let body = '';
    for (let j = currentIndex + 1; j < existingLength; j++) {
      // Truncate components to show if there are more than 10 remaining
      if (j === currentIndex + 11) {
        const otherCount = existingLength - currentIndex - 11;
        body += nls.localize('warning_prompt_other_not_shown', otherCount);
        break;
      }
      const { fileName, type } = foundComponents[j];
      body += `${type}:${fileName}\n`;
    }
    const otherFilesCount = existingLength - currentIndex - 1;
    return nls.localize(
      'warning_prompt_overwrite_message',
      current.type,
      current.fileName,
      otherFilesCount > 0
        ? nls.localize('warning_prompt_other_existing', otherFilesCount)
        : '',
      body
    );
  }

  private buildDialogOptions(
    foundComponents: LocalComponent[],
    skipped: Set<LocalComponent>,
    currentIndex: number
  ) {
    const choices = [nls.localize('warning_prompt_overwrite')];
    const numOfExistingFiles = foundComponents.length;
    if (skipped.size > 0 || skipped.size !== numOfExistingFiles - 1) {
      choices.push(nls.localize('warning_prompt_skip'));
    }
    if (currentIndex < numOfExistingFiles - 1) {
      const othersCount = numOfExistingFiles - currentIndex;
      choices.push(
        `${nls.localize('warning_prompt_overwrite_all')} (${othersCount})`,
        `${nls.localize('warning_prompt_skip_all')} (${othersCount})`
      );
    }
    return choices;
  }
}

export interface ConflictDetectionMessages {
  warningMessageKey: string;
  commandHint: (input: string) => string;
}

export class ConflictDetectionChecker implements PostconditionChecker<string> {
  private messages: ConflictDetectionMessages;

  public constructor(messages: ConflictDetectionMessages) {
    this.messages = messages;
  }

  public async check(
    inputs: ContinueResponse<string> | CancelResponse
  ): Promise<ContinueResponse<string> | CancelResponse> {
    if (!sfdxCoreSettings.getConflictDetectionEnabled()) {
      return inputs;
    }

    if (inputs.type === 'CONTINUE') {
      const usernameOrAlias = await this.getDefaultUsernameOrAlias();
      if (!usernameOrAlias) {
        return {
          type: 'CANCEL',
          msg: nls.localize('conflict_detect_no_default_username')
        };
      }

      const defaultPackageDir = await SfdxPackageDirectories.getDefaultPackageDir();
      if (!defaultPackageDir) {
        return {
          type: 'CANCEL',
          msg: nls.localize('conflict_detect_no_default_package_dir')
        };
      }

      const config: ConflictDetectionConfig = {
        usernameOrAlias,
        packageDir: defaultPackageDir,
        manifest: inputs.data
      };
      const results = await conflictDetector.checkForConflicts(config);

      if (results.different.size > 0) {
        channelService.appendLine(
          nls.localize(
            'conflict_detect_conflict_header',
            results.different.size,
            results.scannedRemote,
            results.scannedLocal
          )
        );
        results.different.forEach(file => {
          channelService.appendLine(join(defaultPackageDir, file));
        });
        channelService.showChannelOutput();

        const choice = await notificationService.showWarningModal(
          nls.localize(this.messages.warningMessageKey),
          nls.localize('conflict_detect_override')
        );

        if (choice !== nls.localize('conflict_detect_override')) {
          channelService.appendLine(
            nls.localize(
              'conflict_detect_command_hint',
              this.messages.commandHint(inputs.data)
            )
          );
          channelService.showChannelOutput();
          return { type: 'CANCEL' };
        }
      }
      return inputs;
    }
    return { type: 'CANCEL' };
  }

  public async getDefaultUsernameOrAlias(): Promise<string | undefined> {
    return await OrgAuthInfo.getDefaultUsernameOrAlias(true);
  }
}
