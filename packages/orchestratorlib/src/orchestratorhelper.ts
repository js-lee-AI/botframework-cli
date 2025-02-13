/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
require('fast-text-encoding');

import {ITextUtteranceLabelMapDataStructure, Label, LabelStructureUtility, LabelType, ScoreEntity, ScoreIntent} from '@microsoft/bf-dispatcher';
import {LabelResolver} from './labelresolver';
import {UtilityLabelResolver} from './utilitylabelresolver';
import {PrebuiltToRecognizerMap} from './resources/recognizer-map';
import {OrchestratorBuild, OrchestratorSettings} from '.';
import {Utility} from './utility';
import {Utility as UtilityDispatcher} from '@microsoft/bf-dispatcher';

const ReadText: any = require('read-text-file');
const luisCollateBuildNoValidate: any = require('@microsoft/bf-lu/lib/parser/luis/luisCollate').build;
const QnaMakerBuilder: any = require('@microsoft/bf-lu').V2.QnAMakerBuilder;
const processedFiles: string[] = [];

export class OrchestratorHelper {
  public static SnapshotFileName: string = 'orchestrator.blu';

  public static exists(path: string): boolean {
    return fs.existsSync(path);
  }

  public static isDirectory(path: string): boolean {
    try {
      const stats: fs.Stats = fs.statSync(path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  public static mkDir(path: string): void {
    fs.mkdirSync(path, {recursive: true});
  }

  public static readFile(filePath: string): string {
    UtilityDispatcher.debuggingLog1(
      'OrchestratorHElper.readFile() calling ReadText.readSync()',
      filePath);
    try {
      const fileStats: fs.Stats = fs.statSync(filePath);
      if (fileStats.size === 0) {
        return '';
      }
      return ReadText.readSync(filePath);
    } catch (error) {
      UtilityDispatcher.debuggingLog2(
        'EXCEPTION calling ReadText.readSync()',
        filePath,
        error);
      throw error;
    }
  }

  public static writeToFile(filePath: string, content: string, options: any = {encoding: 'utf8', flag: 'w'}): string {
    const resolvedFilePath: string = Utility.dumpFile(filePath, content, options);
    if (Utility.isEmptyString(resolvedFilePath)) {
      Utility.debuggingLog(`ERROR: failed writing to file ${resolvedFilePath}`);
    } else {
      Utility.debuggingLog(`Successfully wrote to file ${resolvedFilePath}`);
    }
    return resolvedFilePath;
  }

  public static deleteFile(filePath: string) {
    fs.unlinkSync(filePath);
  }

  public static createDteContent(utteranceLabelsMap: Map<string, Set<string>>) {
    const labelUtteranceMap: Map<string, string> = new Map<string, string>();
    // eslint-disable-next-line guard-for-in
    for (const utterance of utteranceLabelsMap.keys()) {
      const labels: Set<string> = utteranceLabelsMap.get(utterance) as Set<string>;
      labels.forEach((label: string) => {
        if (label in labelUtteranceMap) {
          labelUtteranceMap.set(label, labelUtteranceMap.get(label) + '|' + utterance);
        } else {
          labelUtteranceMap.set(label, utterance);
        }
      });
    }
    let key: number = 0;
    let tsvContent: string = '';
    // eslint-disable-next-line guard-for-in
    for (const label in labelUtteranceMap) {
      const utterances: string = labelUtteranceMap.get(label) as string;
      const line: string = key + '\t' + label + '\t' + utterances + '\n';
      tsvContent += line;
      key += 1;
    }

    return tsvContent;
  }

  public static async getTsvContent(
    inputPathConfiguration: string,
    hierarchical: boolean = false,
    outputDteFormat: boolean = false) {
    const utteranceLabelsMap: Map<string, Set<string>> =
      (await OrchestratorHelper.getUtteranceLabelsMap(inputPathConfiguration, hierarchical)).utteranceLabelsMap;
    let tsvContent: string = '';

    if (outputDteFormat) {
      tsvContent = OrchestratorHelper.createDteContent(utteranceLabelsMap);
    } else {
      // eslint-disable-next-line guard-for-in
      for (const utterance of utteranceLabelsMap.keys()) {
        const labels: Set<string> = utteranceLabelsMap.get(utterance) as Set<string>;
        const line: string = [...labels].join() + '\t' + utterance + '\n';
        tsvContent += line;
      }
    }

    return tsvContent;
  }

  public static getSnapshotFromFile(snapshotPath: string) {
    UtilityDispatcher.debuggingLog1(
      'OrchestratorHelper.getSnapshotFromFile()',
      snapshotPath);
    if (Utility.exists(snapshotPath) && !OrchestratorHelper.isDirectory(snapshotPath)) {
      return new TextEncoder().encode(OrchestratorHelper.readFile(snapshotPath));
    }
    return new Uint8Array();
  }

  public static async getUtteranceLabelsMap(
    filePathConfiguration: string,
    hierarchical: boolean = false,
    routingName: string = ''): Promise<ITextUtteranceLabelMapDataStructure> {
    const utteranceLabelsMap: Map<string, Set<string>> = new Map<string, Set<string>>();
    const utteranceLabelDuplicateMap: Map<string, Set<string>> = new Map<string, Set<string>>();
    const utteranceEntityLabelsMap: Map<string, Label[]> = new Map<string, Label[]>();
    const utteranceEntityLabelDuplicateMap: Map<string, Label[]> = new Map<string, Label[]>();
    const filePaths: string[] = filePathConfiguration.split(',');
    for (const filePathEntry of filePaths) {
      if (OrchestratorHelper.isDirectory(filePathEntry)) {
        // eslint-disable-next-line no-await-in-loop
        await OrchestratorHelper.iterateInputFolder(
          filePathEntry,
          utteranceLabelsMap,
          utteranceLabelDuplicateMap,
          utteranceEntityLabelsMap,
          utteranceEntityLabelDuplicateMap,
          hierarchical);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await OrchestratorHelper.processFile(
          filePathEntry,
          OrchestratorHelper.getRoutingNameFromFileName(filePathEntry, hierarchical, routingName),
          utteranceLabelsMap,
          utteranceLabelDuplicateMap,
          utteranceEntityLabelsMap,
          utteranceEntityLabelDuplicateMap);
      }
    }
    return {
      utteranceLabelsMap,
      utteranceLabelDuplicateMap,
      utteranceEntityLabelsMap,
      utteranceEntityLabelDuplicateMap,
    };
  }

  public static getSnapshotFilePath(out: string, input: string): string {
    let retValue: string = out;
    if (OrchestratorHelper.isDirectory(out)) {
      if (OrchestratorHelper.isDirectory(input)) {
        retValue = path.join(out, OrchestratorHelper.SnapshotFileName);
      } else {
        const srcBaseFileName: string = path.basename(input);
        const dstBaseFileName: string = srcBaseFileName.substring(0, srcBaseFileName.lastIndexOf('.'));
        retValue = path.join(out, `${dstBaseFileName}.blu`);
      }
    }
    return retValue;
  }

  public static getDialogFilesContent(baseName: string, recognizers: any = [], routingName: string = '', skillName: string = '') {
    let recoContent: any;
    if (Utility.isEmptyString(skillName)) {
      recoContent = {
        $kind: 'Microsoft.OrchestratorRecognizer',
        modelFolder: '=settings.orchestrator.modelPath',
        snapshotFile: `=settings.orchestrator.snapshots.${baseName}`,
        entityRecognizers: recognizers,
      };
    } else {
      // eslint-disable-next-line no-warning-comments
      // TODO: remove $designer or generate the id with randomly generated 6 alphanumeric characters
      routingName = Utility.isEmptyString(routingName) ? baseName : routingName;
      recoContent = {
        $kind: 'Microsoft.OnIntent',
        $designer: {
          id: '2oSiwz',
          name: `${routingName}`,
        },
        intent: `${routingName}`,
        actions: [
          {
            $kind: 'Microsoft.BeginSkill',
            $designer: {
              id: 'pDok9V',
            },
            activityProcessed: true,
            botId: '=settings.MicrosoftAppId',
            skillHostEndpoint: '=settings.skillHostEndpoint',
            connectionName: '=settings.connectionName',
            allowInterruptions: true,
            skillEndpoint: `=settings.skill['${skillName}'].endpointUrl`,
            skillAppId: `=settings.skill['${skillName}'].msAppId`,
          },
        ],
      };
    }

    const multiRecoContent: any = {
      $kind: 'Microsoft.MultiLanguageRecognizer',
      recognizers: {
        'en-us': `${baseName}.en-us.lu`,
        '': `${baseName}.en-us.lu`,
      },
    };
    return {orchestratorRecognizer: recoContent, multiLanguageRecognizer: multiRecoContent};
  }

  public static async getEntitiesInLu(luObject: any): Promise<any> {
    const luisObject: any = await luisCollateBuildNoValidate([luObject], false, '', OrchestratorHelper.findLuFiles);
    return this.transformEntities(luisObject);
  }

  public static transformEntities(luisObject: any): string[] {
    if (luisObject.prebuiltEntities === undefined || !Array.isArray(luisObject.prebuiltEntities) || luisObject.prebuiltEntities.length === 0) return [];
    const entitiesList: any = [];
    (luisObject.prebuiltEntities || []).forEach((item: any) => {
      const mapValue: any = PrebuiltToRecognizerMap[item.name.toLowerCase().trim()];
      if (mapValue !== undefined && mapValue !== '') {
        entitiesList.push({
          $kind: mapValue,
        });
      } else {
        process.stdout.write(`\n[WARN:] No entity recognizer available for Prebuilt entity '${item.name}'\n`);
      }
    });
    return entitiesList;
  }

  public static jsonStringify(obj: any): string {
    return JSON.stringify(
      obj,
      (key: string, value: any) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const replacement: any = {};
          for (const k in value) {
            if (Object.hasOwnProperty.call(value, k)) {
              replacement[k && k.charAt(0).toLowerCase() + k.substring(1)] = value[k];
            }
          }
          return replacement;
        }
        return value;
      },
      2);
  }

  // eslint-disable-next-line max-params
  static async processFile(
    filePath: string,
    routingName: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): Promise<void> {
    const ext: string = path.extname(filePath);
    if (ext !== '.lu' &&
      ext !== '.json' &&
      ext !== '.qna' &&
      ext !== '.tsv' &&
      ext !== '.txt' &&
      ext !== '.blu' &&
      ext !== '.dispatch') {
      throw new Error(`${filePath} has invalid extension - only lu, qna, json, tsv and dispatch files are supported.`);
    }

    Utility.writeStringLineToConsoleStdout(`Processing ${filePath}...`);
    try {
      switch (ext) {
        case '.lu':
          await OrchestratorHelper.parseLuFile(
            filePath,
            routingName,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap,
            utteranceEntityLabelsMap,
            utteranceEntityLabelDuplicateMap);
          break;

        case '.qna':
          await OrchestratorHelper.parseQnaFile(
            filePath,
            routingName,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap);
          break;

        case '.json':
          if (filePath.endsWith(OrchestratorSettings.OrchestratorSettingsFileName)) {
            return;
          }
          if (OrchestratorHelper.getIntentsEntitiesUtterances(
            fs.readJsonSync(filePath),
            routingName,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap,
            utteranceEntityLabelsMap,
            utteranceEntityLabelDuplicateMap)) {
            return;
          }
          if (!OrchestratorHelper.getJsonIntentsEntitiesUtterances(
            fs.readJsonSync(filePath),
            routingName,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap,
            utteranceEntityLabelsMap,
            utteranceEntityLabelDuplicateMap)) {
            throw new Error('Failed to parse LUIS or JSON file on intent/entity labels');
          }
          break;

        case '.tsv':
        case '.txt':
          OrchestratorHelper.parseTsvFile(
            filePath,
            routingName,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap);
          break;

        case '.blu':
          OrchestratorHelper.parseTsvBluFile(
            filePath,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap);
          break;

        default: throw new Error(`Unknown file type ${ext}`);
      }
    } catch (error: any) {
      throw new Error(`${error.message}${os.EOL}Failed to parse ${filePath}, error=${os.EOL}${UtilityDispatcher.jsonStringify(error)}`);
    }
  }

  // eslint-disable-next-line max-params
  static parseJsonBluFile(
    jsonBluFile: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>) {
    const fileContents: string = OrchestratorHelper.readFile(jsonBluFile);
    Utility.debuggingLog('BEFORE calling OrchestratorHelper.parseJsonBluFile()');
    // Utility.debuggingLog(`BEFORE calling OrchestratorHelper.parseJsonBluFile(), fileContents=${fileContents}`);
    const jsonBluObject: any = JSON.parse(fileContents);
    Utility.debuggingLog('AFTER calling OrchestratorHelper.parseJsonBluFile()');
    OrchestratorHelper.getJsonBluIntentsEntitiesUtterances(
      jsonBluObject,
      hierarchicalLabel,
      utteranceLabelsMap,
      utteranceLabelDuplicateMap,
      utteranceEntityLabelsMap,
      utteranceEntityLabelDuplicateMap);
  }

  static parseTsvBluFile(
    bluFile: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>) {
    const lines: string[] = OrchestratorHelper.readFile(bluFile).split('\n');
    if (lines.length === 0 || lines.length === 1) {
      return;
    }
    lines.shift();
    OrchestratorHelper.tryParseLabelUtteranceTsv(lines, utteranceLabelsMap, utteranceLabelDuplicateMap, true);
  }

  // eslint-disable-next-line max-params
  static async parseLuFile(
    luFile: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): Promise<void> {
    await OrchestratorHelper.parseLuContent(
      luFile,
      OrchestratorHelper.readFile(luFile),
      hierarchicalLabel,
      utteranceLabelsMap,
      utteranceLabelDuplicateMap,
      utteranceEntityLabelsMap,
      utteranceEntityLabelDuplicateMap);
  }

  // eslint-disable-next-line max-params
  static async parseLuContent(
    luFile: string,
    luContent: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): Promise<void> {
    UtilityDispatcher.debuggingLog1(
      'OrchestratorHelper.parseLuContent()',
      luFile);
    UtilityDispatcher.debuggingLog1(
      'OrchestratorHelper.parseLuContent()',
      luContent);
    if (!luContent || luContent.length === 0) {
      return;
    }
    try {
      const luObject: any = {
        content: luContent,
        id: luFile,
      };
      const luisObject: any = await luisCollateBuildNoValidate([luObject], false, '', OrchestratorHelper.findLuFiles);
      if (Utility.toPrintDetailedDebuggingLogToConsole) {
        UtilityDispatcher.debuggingNamedLog1('OrchestratorHelper.parseLuContent(): calling getIntentsEntitiesUtterances()', luisObject, 'luisObject');
      }
      const rvLu: boolean = OrchestratorHelper.getIntentsEntitiesUtterances(
        luisObject,
        hierarchicalLabel,
        utteranceLabelsMap,
        utteranceLabelDuplicateMap,
        utteranceEntityLabelsMap,
        utteranceEntityLabelDuplicateMap);
      if (!rvLu) {
        throw new Error('Failed to parse LUIS or JSON file on intent/entity labels');
      }
    } catch (error: any) {
      Utility.debuggingLog(`EXCEPTION calling getIntentsEntitiesUtterances(), error=${error}`);
      throw new Error(`Failed parsing lu file ${luFile} ${error.text}`);
    }
  }

  static parseTsvFile(
    tsvFile: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>) {
    Utility.debuggingLog(`OrchestratorHelper.parseTsvFile(), ready to read from '${tsvFile}'`);
    const lines: string[] = OrchestratorHelper.readFile(tsvFile).split('\n');
    Utility.debuggingLog(`OrchestratorHelper.parseTsvFile(), lines=${lines.length}`);
    if (lines.length === 0) {
      return;
    }
    if (!OrchestratorHelper.tryParseQnATsvFile(lines, hierarchicalLabel, utteranceLabelsMap, utteranceLabelDuplicateMap)) {
      OrchestratorHelper.tryParseLabelUtteranceTsv(lines, utteranceLabelsMap, utteranceLabelDuplicateMap);
    }
  }

  static tryParseLabelUtteranceTsv(
    lines: string[],
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    bluFormat: boolean = false): boolean {
    if (!bluFormat && OrchestratorHelper.hasLabelUtteranceHeader(lines[0])) {
      lines.shift();
    }
    Utility.debuggingLog(`processing #lines=${lines.length}`);
    let numberLinesProcessed: number = 0;
    let numberLinesIgnored: number = 0;
    lines.forEach((line: string, lineIndex: number) => {
      if ((lineIndex % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
        // eslint-disable-next-line no-console
        Utility.debuggingLog(`processed lineIndex=${lineIndex}`);
      }
      /** ---- NOTE-FOR-TESTING-INSTRUMENTATION ----
       *  if (lineIndex >= 8630000) {
       *    // eslint-disable-next-line no-console
       *    Utility.debuggingLog(`processed lineIndex=${lineIndex}, line='${line}'`);
       *  }
       */
      const lineTrimmed: string = line.trim();
      if (lineTrimmed.length <= 0) {
        Utility.debuggingLog(`WARNING processing lineIndex=${lineIndex}, line='${line}', lineTrimmed.length <= 0`);
        numberLinesIgnored++;
        if ((numberLinesIgnored % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
          // eslint-disable-next-line no-console
          Utility.debuggingLog(`processed numberLinesIgnored=${numberLinesIgnored}`);
        }
        return;
      }
      try {
        const items: string[] = lineTrimmed.split('\t');
        if (items && (items.length >= 2)) {
          let labels: string = items[0] ? items[0] : '';
          const utteranceIdx: number = (items.length === 3 && !bluFormat) ? 2 : 1;
          let utterance: string = items[utteranceIdx] ? items[utteranceIdx] : '';
          labels = labels.trim();
          utterance = utterance.trim();
          /** ---- NOTE-FOR-TESTING-INSTRUMENTATION ----
           *  if (utterance === 'constructor') {
           *    Utility.debuggingLog(`WARNING processing, utterance === 'constructor', lineIndex=${lineIndex}, line='${line}'`);
           *    numberLinesIgnored++;
           *    if ((numberLinesIgnored % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
           *      // eslint-disable-next-line no-console
           *      Utility.debuggingLog(`processed numberLinesIgnored=${numberLinesIgnored}`);
           *    }
           *    return;
           *  }
           */
          const labelArray: string[] = labels.split(',');
          for (const label of labelArray) {
            if (label) {
              const labelTrimmed: string = label.trim();
              OrchestratorHelper.addNewLabelUtterance(
                utterance,
                labelTrimmed,
                '',
                utteranceLabelsMap,
                utteranceLabelDuplicateMap);
            }
          }
          numberLinesProcessed++;
          if ((numberLinesProcessed % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
            // eslint-disable-next-line no-console
            Utility.debuggingLog(`processed numberLinesProcessed=${numberLinesProcessed}`);
          }
        } else {
          Utility.debuggingLog(`WARNING processing, items.length < 2, lineIndex=${lineIndex}, line='${line}'`);
          numberLinesIgnored++;
          if ((numberLinesIgnored % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
            // eslint-disable-next-line no-console
            Utility.debuggingLog(`processed numberLinesIgnored=${numberLinesIgnored}`);
          }
        }
      } catch (error) {
        Utility.debuggingLog(`WARNING processing lineIndex=${lineIndex}, line='${line}', error=${error}`);
        numberLinesIgnored++;
        if ((numberLinesIgnored % Utility.NumberOfInstancesPerProgressDisplayBatch) === 0) {
          // eslint-disable-next-line no-console
          Utility.debuggingLog(`processed numberLinesIgnored=${numberLinesIgnored}`);
        }
        throw error;
      }
    });
    Utility.debuggingLog(`processed #lines=${lines.length}`);
    Utility.debuggingLog(`processed numberLinesProcessed=${numberLinesProcessed}`);
    Utility.debuggingLog(`processed numberLinesIgnored=${numberLinesIgnored}`);
    Utility.debuggingLog(`processed utteranceLabelsMap.size=${utteranceLabelsMap.size}`);
    Utility.debuggingLog(`processed utteranceLabelDuplicateMap.size=${utteranceLabelDuplicateMap.size}`);
    return true;
  }

  static tryParseQnATsvFile(
    lines: string[],
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>): boolean {
    if (!OrchestratorHelper.isQnATsvHeader(lines[0])) {
      return false;
    }
    const hasLabel: boolean = !Utility.isEmptyString(hierarchicalLabel);
    lines.shift();
    lines.forEach((line: string) => {
      const items: string[] = line.split('\t');
      if (items.length < 2) {
        return;
      }
      OrchestratorHelper.addNewLabelUtterance(
        items[0].trim(),
        hasLabel ? hierarchicalLabel : Utility.cleanStringOnSpaceCommas(items[1].trim()),
        '',
        utteranceLabelsMap,
        utteranceLabelDuplicateMap);
    });

    return true;
  }

  static isQnATsvHeader(header: string): boolean {
    return header.indexOf('Question') >= 0 && header.indexOf('Answer') > 0;
  }

  static hasLabelUtteranceHeader(header: string): boolean {
    return header.indexOf('Label') >= 0 &&
      (header.indexOf('Text') > 0 || header.indexOf('Utterance') > 0);
  }

  static async parseQnaFile(
    qnaFile: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>): Promise<void> {
    const fileContents: string = OrchestratorHelper.readFile(qnaFile);
    const lines: string[] = fileContents.split('\n');
    if (lines.length === 0) {
      return;
    }

    try {
      const qnaObject: any = await QnaMakerBuilder.fromContent(fileContents);
      OrchestratorHelper.getQnaQuestionsAsUtterances(qnaObject, hierarchicalLabel, utteranceLabelsMap, utteranceLabelDuplicateMap);
    } catch (error: any) {
      throw new Error(`Failed parsing qna file ${qnaFile} ${error.text}\n${JSON.stringify(error)}`);
    }
  }

  // eslint-disable-next-line max-params
  static async iterateInputFolder(
    folderPath: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>,
    hierarchical: boolean): Promise<void> {
    const supportedFileFormats: string[] = ['.lu', '.json', '.qna', '.tsv', '.txt'];
    const files: string[] = fs.readdirSync(folderPath);
    for (const file of files) {
      const currentItemPath: string = path.join(folderPath, file);
      const isDirectory: boolean = OrchestratorHelper.isDirectory(currentItemPath);
      if (isDirectory) {
        // eslint-disable-next-line no-await-in-loop
        await OrchestratorHelper.iterateInputFolder(
          currentItemPath,
          utteranceLabelsMap,
          utteranceLabelDuplicateMap,
          utteranceEntityLabelsMap,
          utteranceEntityLabelDuplicateMap,
          hierarchical);
      } else {
        const ext: string = path.extname(file);
        if (processedFiles.includes(currentItemPath)) {
          continue;
        }
        if (supportedFileFormats.indexOf(ext) > -1) {
          // eslint-disable-next-line no-await-in-loop
          await OrchestratorHelper.processFile(
            currentItemPath,
            OrchestratorHelper.getRoutingNameFromFileName(file, hierarchical),
            utteranceLabelsMap,
            utteranceLabelDuplicateMap,
            utteranceEntityLabelsMap,
            utteranceEntityLabelDuplicateMap);
        }
      }
    }
  }

  // eslint-disable-next-line max-params
  static getIntentsEntitiesUtterances(
    luisObject: any,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): boolean {
    try {
      // eslint-disable-next-line no-prototype-builtins
      if (luisObject.hasOwnProperty('utterances')) {
        luisObject.utterances.forEach((e: any) => {
          const label: string = e.intent.trim();
          const utterance: string = e.text.trim();
          OrchestratorHelper.addNewLabelUtterance(
            utterance,
            label,
            hierarchicalLabel,
            utteranceLabelsMap,
            utteranceLabelDuplicateMap);
          const entities: any[] = e.entities;
          entities.forEach((entityEntry: any) => {
            OrchestratorHelper.addNewEntityLabelUtterance(
              utterance,
              entityEntry,
              utteranceEntityLabelsMap,
              utteranceEntityLabelDuplicateMap);
          });
        });
        return true;
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling getIntentsEntitiesUtterances(), error=${error}`);
      throw error;
    }
    return false;
  }

  static getQnaQuestionsAsUtterances(
    qnaObject: any,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>): void {
    // Utility.debuggingLog(`OrchestratorHelper.getQnaQuestionsAsUtterances() called, qnaObject=${Utility.jsonStringify(qnaObject)}`);
    const hasLabel: boolean = !Utility.isEmptyString(hierarchicalLabel);
    qnaObject.kb.qnaList.forEach((e: any) => {
      let answer: string;
      if (hasLabel) {
        answer = hierarchicalLabel;
      } else {
        answer = Utility.cleanStringOnSpaceCommas(e.answer);
      }
      const questions: string[] = e.questions;
      questions.forEach((q: string) => {
        OrchestratorHelper.addNewLabelUtterance(
          q.trim(),
          answer,
          '',
          utteranceLabelsMap,
          utteranceLabelDuplicateMap);
      });
    });
  }

  // eslint-disable-next-line max-params
  static getJsonBluIntentsEntitiesUtterances(
    jsonBluObject: any,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): boolean {
    try {
      let jsonBluExamplesArray: any = null;
      // eslint-disable-next-line no-prototype-builtins
      if (jsonBluObject.hasOwnProperty('examples')) {
        jsonBluExamplesArray = jsonBluObject.examples;
      } else {
        return false;
      }
      if (jsonBluExamplesArray.length > 0) {
        jsonBluExamplesArray.forEach((jsonBluExample: any) => {
          const utterance: string = jsonBluExample.text.trim();
          // eslint-disable-next-line no-prototype-builtins
          if (jsonBluExample.hasOwnProperty('intents')) {
            const jsonBluExampleIntents: any = jsonBluExample.intents;
            jsonBluExampleIntents.forEach((jsonBluExampleIntent: any) => {
              const jsonBluExampleIntentLabel: string = jsonBluExampleIntent.name;
              OrchestratorHelper.addNewLabelUtterance(
                utterance,
                jsonBluExampleIntentLabel,
                hierarchicalLabel,
                utteranceLabelsMap,
                utteranceLabelDuplicateMap);
            });
          }
          // eslint-disable-next-line no-prototype-builtins
          if (jsonBluExample.hasOwnProperty('entities')) {
            const jsonBluExampleEntities: any[] = jsonBluExample.entities;
            jsonBluExampleEntities.forEach((jsonBluExampleEntity: any) => {
              const jsonBluExampleEntityLabel: string = jsonBluExampleEntity.entity;
              const jsonBluExampleEntityOffset: number = jsonBluExampleEntity.offset;
              const jsonBluExampleEntityLength: number = jsonBluExampleEntity.length;
              const newEntityLabel: Label = Label.newEntityLabel(jsonBluExampleEntityLabel, jsonBluExampleEntityOffset, jsonBluExampleEntityLength);
              OrchestratorHelper.addNewEntityLabelObjectUtterance(
                utterance,
                newEntityLabel,
                utteranceEntityLabelsMap,
                utteranceEntityLabelDuplicateMap);
            });
          }
        });
        return true;
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling getJsonIntentsEntitiesUtterances(), error=${error}`);
      throw error;
    }
    return false;
  }

  // eslint-disable-next-line max-params
  static getJsonIntentsEntitiesUtterances(
    jsonObjectArray: any,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): boolean {
    try {
      if (jsonObjectArray.length > 0) {
        jsonObjectArray.forEach((jsonObject: any) => {
          const utterance: string = jsonObject.text.trim();
          // eslint-disable-next-line no-prototype-builtins
          if (jsonObject.hasOwnProperty('intents')) {
            const labels: string[] = jsonObject.intents;
            labels.forEach((label: string) => {
              OrchestratorHelper.addNewLabelUtterance(
                utterance,
                label,
                hierarchicalLabel,
                utteranceLabelsMap,
                utteranceLabelDuplicateMap);
            });
          }
          // eslint-disable-next-line no-prototype-builtins
          if (jsonObject.hasOwnProperty('entities')) {
            const entities: any[] = jsonObject.entities;
            entities.forEach((entityEntry: any) => {
              OrchestratorHelper.addNewEntityLabelUtterance(
                utterance,
                entityEntry,
                utteranceEntityLabelsMap,
                utteranceEntityLabelDuplicateMap);
            });
          }
        });
        return true;
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling getJsonIntentsEntitiesUtterances(), error=${error}`);
      throw error;
    }
    return false;
  }

  // eslint-disable-next-line max-params
  static getExampleArrayIntentsEntitiesUtterances(
    exampleArray: any,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): boolean {
    try {
      if (exampleArray.length > 0) {
        exampleArray.forEach((example: any) => {
          const utterance: string = example.text.trim();
          // eslint-disable-next-line no-prototype-builtins
          if (example.hasOwnProperty('labels')) {
            const labels: any[] = example.labels;
            labels.forEach((label: any) => {
              // eslint-disable-next-line no-prototype-builtins
              if (label.hasOwnProperty('label_type')) {
                const labelName: string = label.name;
                const labelType: LabelType = LabelStructureUtility.numberToLabelType(label.label_type);
                if (labelType === LabelType.Intent) {
                  OrchestratorHelper.addNewLabelUtterance(
                    utterance,
                    labelName,
                    hierarchicalLabel,
                    utteranceLabelsMap,
                    utteranceLabelDuplicateMap);
                } else if (labelType === LabelType.Entity) {
                  const labelSpanOffset: number = label.span.offset;
                  const labelSpanLength: number = label.span.length;
                  const newEntityLabel: Label = Label.newEntityLabel(labelName, labelSpanOffset, labelSpanLength);
                  OrchestratorHelper.addNewEntityLabelObjectUtterance(
                    utterance,
                    newEntityLabel,
                    utteranceEntityLabelsMap,
                    utteranceEntityLabelDuplicateMap);
                }
              } else {
                UtilityDispatcher.debuggingNamedLog1(
                  'OrchestratorHelper.getExampleArrayIntentsEntitiesUtterances(), input example does not have label type',
                  label,
                  'label');
              }
            });
          }
        });
        return true;
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling getExampleArrayIntentsEntitiesUtterances(), error=${error}`);
      throw error;
    }
    return false;
  }

  static getJsonIntentEntityScoresUtterances(
    jsonObjectArray: any,
    utteranceLabelScoresMap: Map<string, ScoreIntent[]>,
    utteranceEntityLabelScoresMap: Map<string, ScoreEntity[]>): boolean {
    try {
      if (jsonObjectArray.length > 0) {
        jsonObjectArray.forEach((jsonObject: any) => {
          const utterance: string = jsonObject.text.trim();
          // eslint-disable-next-line no-prototype-builtins
          if (jsonObject.hasOwnProperty('intent_scores')) {
            const intentScores: any[] = jsonObject.intent_scores;
            utteranceLabelScoresMap.set(utterance, intentScores.map((intentScore: any) => {
              const intent: string = intentScore.intent;
              const score: number = intentScore.score;
              return ScoreIntent.newScoreIntent(intent, score);
            }));
          }
          // eslint-disable-next-line no-prototype-builtins
          if (jsonObject.hasOwnProperty('entity_scores')) {
            const entityScores: any[] = jsonObject.entity_scores;
            utteranceEntityLabelScoresMap.set(utterance, entityScores.map((entityScore: any) => {
              const entity: string = entityScore.entity;
              const startPos: number = entityScore.startPos;
              const endPos: number = entityScore.endPos;
              const score: number = entityScore.score;
              return ScoreEntity.newScoreEntityByPosition(entity, score, startPos, endPos);
            }));
          }
        });
        return true;
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling getJsonIntentEntityScoresUtterances(), error=${error}`);
      throw error;
    }
    return false;
  }

  static getRoutingNameFromFileName(filePath: string, hierarchical: boolean, routingName: string = '') {
    if (!hierarchical) {
      return '';
    }
    const fileName: string = path.basename(filePath);
    const ext: string = path.extname(filePath);
    return Utility.isEmptyString(routingName) ? fileName.substr(0, fileName.length - ext.length) : routingName;
  }

  // ---- NOTE-TO-REFACTOR ----
  // eslint-disable-next-line max-params
  static addNewLabelUtterance(
    utterance: string,
    label: string,
    hierarchicalLabel: string,
    utteranceLabelsMap: Map<string, Set<string>>,
    utteranceLabelDuplicateMap: Map<string, Set<string>>): void {
    const isHierarchicalLabel: boolean = !Utility.isEmptyString(hierarchicalLabel);
    let existingLabels: Set<string> = new Set<string>();
    try {
      if (utteranceLabelsMap.has(utterance)) {
        existingLabels = utteranceLabelsMap.get(utterance) as Set<string>;
      }
      if (existingLabels.size > 0) {
        if (isHierarchicalLabel) {
          if (!OrchestratorHelper.addUniqueLabel(hierarchicalLabel, existingLabels)) {
            Utility.insertStringPairToStringIdStringSetNativeMap(utterance, hierarchicalLabel, utteranceLabelDuplicateMap);
          }
        } else if (!OrchestratorHelper.addUniqueLabel(label, existingLabels)) {
          Utility.insertStringPairToStringIdStringSetNativeMap(utterance, label, utteranceLabelDuplicateMap);
        }
      } else if (isHierarchicalLabel) {
        existingLabels.add(hierarchicalLabel);
        utteranceLabelsMap.set(utterance, existingLabels);
      } else {
        existingLabels.add(label);
        utteranceLabelsMap.set(utterance, existingLabels);
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addNewLabelUtterance(), error='${error}', label='${label}', utterance='${utterance}', hierarchicalLabel='${hierarchicalLabel}', isHierarchicalLabel='${isHierarchicalLabel}', existingLabels='${existingLabels}'`);
      throw error;
    }
  }

  // ---- NOTE-TO-REFACTOR ----
  // eslint-disable-next-line max-params
  static addNewEntityLabelUtteranceTraversal(
    utterance: string,
    existingEntityLabels: Label[],
    entityEntry: any,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>,
    entityLabelPrefix: string = ''): void {
    try {
      let entityName: string = entityEntry.entity;
      const startPos: number = Number(entityEntry.startPos);
      const endPos: number = Number(entityEntry.endPos);
      // const entityMention: string = entityEntry.text;
      if (Utility.isEmptyString(entityName) || (startPos === undefined) || (endPos === undefined)) {
        Utility.debuggingThrow(`EMPTY entityName: '${entityName}', startPos='${startPos}', endPos='${endPos}', entityEntry='${entityEntry}', utterance='${utterance}'`);
      }
      if (!UtilityDispatcher.isEmptyString(entityLabelPrefix)) {
        entityName = `${entityLabelPrefix}:${entityName}`;
      }
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal()-entityName', entityName);
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal()-startPos', startPos);
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal()-endPos', endPos);
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap-B', UtilityDispatcher.jsonStringify([...utteranceEntityLabelsMap]));
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap.size-B', utteranceEntityLabelsMap.size);
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-[...utteranceEntityLabelsMap].length-B', [...utteranceEntityLabelsMap].length);
      const entityLabel: Label = Label.newEntityLabelByPosition(entityName, startPos, endPos);
      if (Utility.isEmptyGenericArray(existingEntityLabels)) {
        existingEntityLabels = [entityLabel];
        utteranceEntityLabelsMap.set(utterance, existingEntityLabels);
        UtilityDispatcher.debuggingLog1(
          'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap-I', UtilityDispatcher.jsonStringify([...utteranceEntityLabelsMap]));
        UtilityDispatcher.debuggingLog1(
          'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap.size-I', utteranceEntityLabelsMap.size);
        UtilityDispatcher.debuggingLog1(
          'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-[...utteranceEntityLabelsMap].length-I', [...utteranceEntityLabelsMap].length);
      } else if (!OrchestratorHelper.addUniqueEntityLabelArray(entityLabel, existingEntityLabels)) {
        Utility.insertStringLabelPairToStringIdLabelSetNativeMap(utterance, entityLabel, utteranceEntityLabelDuplicateMap);
      }
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap-A', UtilityDispatcher.jsonStringify([...utteranceEntityLabelsMap]));
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-utteranceEntityLabelsMap.size-A', utteranceEntityLabelsMap.size);
      UtilityDispatcher.debuggingLog1(
        'OrchestratorHelper.addNewEntityLabelUtteranceTraversal(),-[...utteranceEntityLabelsMap].length-A', [...utteranceEntityLabelsMap].length);
      // eslint-disable-next-line no-prototype-builtins
      if (entityEntry.hasOwnProperty('children')) {
        entityEntry.children.forEach((childEntityEntry: any) => {
          OrchestratorHelper.addNewEntityLabelUtteranceTraversal(
            utterance,
            existingEntityLabels,
            childEntityEntry,
            utteranceEntityLabelsMap,
            utteranceEntityLabelDuplicateMap,
            entityName);
        });
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addNewEntityLabelUtteranceTraversal(), error='${error}', entityEntry='${entityEntry}', utterance='${utterance}', existingEntityLabels='${existingEntityLabels}'`);
      throw error;
    }
  }

  // ---- NOTE-TO-REFACTOR ----
  // eslint-disable-next-line max-params
  static addNewEntityLabelUtterance(
    utterance: string,
    entityEntry: any,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): void {
    let existingEntityLabels: Label[] = [];
    try {
      // eslint-disable-next-line no-prototype-builtins
      if (utteranceEntityLabelsMap.has(utterance)) {
        existingEntityLabels = utteranceEntityLabelsMap.get(utterance) as Label[];
      }
      OrchestratorHelper.addNewEntityLabelUtteranceTraversal(
        utterance,
        existingEntityLabels,
        entityEntry,
        utteranceEntityLabelsMap,
        utteranceEntityLabelDuplicateMap,
        '');
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addNewEntityLabelUtterance(), error='${error}', entityEntry='${entityEntry}', utterance='${utterance}', existingEntityLabels='${existingEntityLabels}'`);
      throw error;
    }
  }

  // ---- NOTE-TO-REFACTOR ----
  // eslint-disable-next-line max-params
  static addNewEntityLabelObjectUtterance(
    utterance: string,
    entityEntry: Label,
    utteranceEntityLabelsMap: Map<string, Label[]>,
    utteranceEntityLabelDuplicateMap: Map<string, Label[]>): void {
    let existingEntityLabels: Label[] = [];
    try {
      // eslint-disable-next-line no-prototype-builtins
      if (utteranceEntityLabelsMap.has(utterance)) {
        existingEntityLabels = utteranceEntityLabelsMap.get(utterance) as Label[];
      }
      const labelType: LabelType = entityEntry.labeltype;
      const entityName: string = entityEntry.name;
      const offset: number = entityEntry.span.offset;
      const length: number = entityEntry.span.length;
      // ---- NOTE-NOT-AVAILABLE ---- const entityMention: string = entityEntry.text;
      if (Utility.isEmptyString(entityName) || (labelType === undefined) || (offset === undefined) || (length === undefined)) {
        Utility.debuggingThrow(`EMPTY entityName: '${entityName}', labelType='${labelType}', offset='${offset}', length='${length}', entityEntry='${entityEntry}', utterance='${utterance}'`);
      }
      if (Utility.isEmptyGenericArray(existingEntityLabels)) {
        existingEntityLabels = [entityEntry];
        utteranceEntityLabelsMap.set(utterance, existingEntityLabels);
      } else if (!OrchestratorHelper.addUniqueEntityLabelArray(entityEntry, existingEntityLabels)) {
        Utility.insertStringLabelPairToStringIdLabelSetNativeMap(utterance, entityEntry, utteranceEntityLabelDuplicateMap);
      }
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addNewEntityLabelUtterance(), error='${error}', entityEntry='${entityEntry}', utterance='${utterance}', existingEntityLabels='${existingEntityLabels}'`);
      throw error;
    }
  }

  // ---- NOTE-TO-REFACTOR ----
  static addUniqueLabel(newLabel: string, labels: Set<string>): boolean {
    try {
      if (labels.has(newLabel)) {
        return false;
      }
      if (Utility.isEmptyString(newLabel)) {
        Utility.debuggingThrow(`EMPTY newLabel: '${newLabel}'`);
      }
      labels.add(newLabel);
      return true;
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addUniqueLabel(), error='${error}', newLabel='${newLabel}', labels='${labels}'`);
      throw error;
    }
    return false;
  }

  // ---- NOTE-TO-REFACTOR ----
  static addUniqueLabelToArray(newLabel: string, labels: string[]): boolean {
    try {
      for (const label of labels) {
        if (label === newLabel) {
          return false;
        }
      }
      labels.push(newLabel);
      return true;
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addUniqueLabelToArray(), error='${error}', newLabel='${newLabel}', labels='${labels}'`);
      throw error;
    }
    return false;
  }

  // ---- NOTE-TO-REFACTOR ----
  static addUniqueEntityLabelArray(newLabel: Label, labels: Label[]): boolean {
    try {
      for (const label of labels) {
        if (label.equals(newLabel)) {
          return false;
        }
      }
      labels.push(newLabel);
      return true;
    } catch (error) {
      Utility.debuggingLog(`EXCEPTION calling addUniqueEntityLabelArray(), error='${error}', newLabel='${newLabel}', labels='${labels}'`);
      throw error;
    }
    return false;
  }

  static findLuFiles(srcId: string, idsToFind: {filePath: string}[]): {content: string; id: string}[] {
    const baseDir: string = path.dirname(srcId);
    const retPayload: any[] = [];
    idsToFind?.forEach((ask: {filePath: string}) => {
      const resourceToFind: string = path.isAbsolute(ask.filePath) ? ask.filePath : path.resolve(path.join(baseDir, ask.filePath));
      const fileContent: string = OrchestratorHelper.readFile(resourceToFind);
      if (fileContent) {
        retPayload.push({
          content: fileContent,
          id: resourceToFind,
        });
        if (!processedFiles.includes(resourceToFind)) {
          processedFiles.push(resourceToFind);
        }
      } else {
        throw new Error(`Content not found for ${resourceToFind}.`);
      }
    });
    return retPayload;
  }

  private static getLuInputsEx(inputPath: string, retPayload: any[]): void {
    if (OrchestratorHelper.isDirectory(inputPath)) {
      const items: string[] = fs.readdirSync(inputPath);
      for (const item of items) {
        const currentItemPath: string = path.join(inputPath, item);
        OrchestratorHelper.getLuInputsEx(currentItemPath, retPayload);
      }
    } else {
      const ext: string = path.extname(inputPath);
      if (ext === '.lu') {
        const content: string = OrchestratorHelper.readFile(inputPath);
        if (content) {
          retPayload.push({
            content: content,
            id: path.basename(inputPath, '.lu'),
          });
        }
      }
    }
  }

  public static getLuInputs(inputPath: string): any[] {
    const retPayload: any[] = [];
    OrchestratorHelper.getLuInputsEx(inputPath, retPayload);
    return retPayload;
  }

  public static getSnapshots(inputPath: string): Map<string, Uint8Array> {
    const snapshots: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    OrchestratorHelper.getSnapshotsEx(inputPath, snapshots);
    return snapshots;
  }

  public static getSnapshotsEx(outputPath: string, snapshots: Map<string, Uint8Array>): void {
    if (OrchestratorHelper.isDirectory(outputPath)) {
      const items: string[] = fs.readdirSync(outputPath);
      for (const item of items) {
        const currentItemPath: string = path.join(outputPath, item);
        OrchestratorHelper.getSnapshotsEx(currentItemPath, snapshots);
      }
    } else {
      const ext: string = path.extname(outputPath);
      if (ext === '.blu') {
        snapshots.set(path.basename(outputPath, '.blu'), OrchestratorHelper.getSnapshotFromFile(outputPath));
      }
    }
  }

  public static writeBuildOutputFiles(outputPath: string, retPayload: any): void {
    const buildOutputs: any[] = retPayload.outputs;
    const bluPaths: any = retPayload.settings.orchestrator.snapshots;
    for (const buildOutput of (buildOutputs || [])) {
      const baseName: any = buildOutput.id;
      const snapshotFile: string = path.join(outputPath, baseName + '.blu');
      OrchestratorHelper.writeToFile(snapshotFile, buildOutput.snapshot);
      Utility.debuggingLog(`Snapshot written to ${snapshotFile}`);

      if (buildOutput.recognizer !== undefined) {
        const recoFileName: string = path.join(outputPath, `${baseName}.lu.dialog`);
        this.writeToFile(recoFileName, Utility.jsonStringify(buildOutput.recognizer.orchestratorRecognizer, null, 2));
        Utility.debuggingLog(`Recognizer file written to ${recoFileName}`);

        const multiRecoFileName: string = path.join(outputPath, `${baseName}.en-us.lu.dialog`);
        this.writeToFile(multiRecoFileName, Utility.jsonStringify(buildOutput.recognizer.multiLanguageRecognizer, null, 2));
        Utility.debuggingLog(`Multi language recognizer file written to ${multiRecoFileName}`);
      }

      bluPaths[baseName] = snapshotFile.replace(/\\/g, '/');
    }
  }

  // eslint-disable-next-line max-params
  public static async processLuContent(
    luObject: any,
    labelResolvers: Map<string, LabelResolver>,
    routingName: string = '',
    isDialog: boolean = false,
    fullEmbedding: boolean = false,
    skillName: string = '') {
    Utility.debuggingLog(`routingName=${routingName}`);

    const baseName: string = luObject.id;

    // Use cached labelResolver
    let labelResolver: any = labelResolvers.get(baseName);
    if (labelResolvers.has(baseName)) {
      // Sync the label resolver with LU content.
      await OrchestratorBuild.syncLabelResolver(labelResolver, luObject.content);

      const snapshot: any = labelResolver.createSnapshot();
      const entities: any = await OrchestratorHelper.getEntitiesInLu(luObject);
      const recognizer: any = isDialog ? OrchestratorHelper.getDialogFilesContent(baseName, entities, routingName, skillName) : undefined;
      return {id: baseName, snapshot: snapshot, recognizer: recognizer};
    }
    // eslint-disable-next-line no-lone-blocks
    {
      // Create new label resolver
      if (!labelResolver) {
        Utility.debuggingLog('OrchestratorHelper.processLuFile(), ready to call LabelResolver.createLabelResolver()');
        labelResolver = LabelResolver.createLabelResolver();
        Utility.debuggingLog('OrchestratorHelper.processLuFile(), after calling LabelResolver.createLabelResolver()');
        Utility.debuggingLog('Created label resolver');
        labelResolvers.set(luObject.id, labelResolver);
      }
      // eslint-disable-next-line no-return-await
      return await OrchestratorHelper.processLuContentSingle(luObject, labelResolver, routingName, isDialog, fullEmbedding, skillName);
    }
  }

  // eslint-disable-next-line max-params
  public static async processLuContentSingle(
    luObject: any,
    labelResolver: LabelResolver,
    routingName: string = '',
    isDialog: boolean = false,
    fullEmbedding: boolean = false,
    skillName: string = '') {
    Utility.debuggingLog(`routingName=${routingName}`);

    const baseName: string = luObject.id;

    // Create new label resolver
    if (!labelResolver) {
      Utility.debuggingLog('OrchestratorHelper.processLuFile(), ready to call LabelResolver.createLabelResolver()');
      labelResolver = LabelResolver.createLabelResolver();
      Utility.debuggingLog('OrchestratorHelper.processLuFile(), after calling LabelResolver.createLabelResolver()');
      Utility.debuggingLog('Created label resolver');
    }
    if (fullEmbedding) {
      UtilityLabelResolver.resetLabelResolverSettingUseCompactEmbeddings(fullEmbedding);
    }
    const result: ITextUtteranceLabelMapDataStructure = {
      utteranceLabelsMap: new Map<string, Set<string>>(),
      utteranceLabelDuplicateMap: new Map<string, Set<string>>(),
      utteranceEntityLabelsMap: new Map<string, Label[]>(),
      utteranceEntityLabelDuplicateMap: new Map<string, Label[]>(),
    };
    await OrchestratorHelper.parseLuContent(
      luObject.id,
      luObject.content,
      routingName,
      result.utteranceLabelsMap,
      result.utteranceLabelDuplicateMap,
      result.utteranceEntityLabelsMap,
      result.utteranceEntityLabelDuplicateMap);
    Utility.debuggingLog(`Processed ${luObject.id}`);
    LabelResolver.addExamples(result, labelResolver);
    const snapshot: any = LabelResolver.createSnapshot(labelResolver);
    const entities: any = await OrchestratorHelper.getEntitiesInLu(luObject);
    const recognizer: any = isDialog ? OrchestratorHelper.getDialogFilesContent(baseName, entities, routingName, skillName) : undefined;
    return {id: baseName, snapshot: snapshot, recognizer: recognizer};
  }
}
