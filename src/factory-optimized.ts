import { Entry } from "@zip.js/zip.js";
import * as common from "./common";
import {
    checkRequirements,
    FactoryProgressCallback,
    tryReboot,
} from "./factory";
import {
    FastbootDevice,
    getOtherSlot,
    PartitionSlot,
    ReconnectCallback,
} from "./fastboot";

enum CommandType {
    CheckRequirements,
    CheckVar,
    Erase,
    Flash,
    MaybeCancelSnapshotUpdate,
    RebootBootloader,
    RunCmd,
    ToggleActiveSlot,
}

interface Command {
    type: CommandType;
}

interface CheckRequirementsCommand extends Command {
    fileName: string;
}

interface CheckVarCommand extends Command {
    varName: string;
    expectedValue: string;
}

interface EraseCommand extends Command {
    partition: string;
}

interface FlashCommand extends Command {
    partition: string;
    fileName: string;
    slot: PartitionSlot;
}

interface RunCmdCommand extends Command {
    command: string;
}

export async function flashOptimizedFactoryZip(
    device: FastbootDevice,
    zipEntriesArr: Entry[],
    wipe: boolean,
    onReconnect: ReconnectCallback,
    onProgress: FactoryProgressCallback = (
        _action: string,
        _item: string,
        _progress: number
    ) => {}
) {
    let zipEntries = new Map<string, Entry>();
    for (let e of zipEntriesArr) {
        zipEntries.set(e.filename, e);
    }

    let flashScript = await FlashScript.parse(zipEntries);

    let flashedBytes = 0;
    for (let cmd_ of flashScript.commands) {
        let totalProgress = flashedBytes / flashScript.totalFlashBytes;
        switch (cmd_.type) {
            case CommandType.CheckRequirements: {
                let cmd = cmd_ as CheckRequirementsCommand;
                let fileEntry = zipEntries.get(cmd.fileName)!;
                await checkRequirements(
                    device,
                    await common.zipGetEntryAsString(fileEntry)
                );
                break;
            }
            case CommandType.CheckVar: {
                let cmd = cmd_ as CheckVarCommand;
                let value = await device.getVariable(cmd.varName);

                if (value !== cmd.expectedValue) {
                    throw new Error(
                        `unexpected value of ${cmd.varName} variable: expected ${cmd.expectedValue}, got ${value}`
                    );
                }
                common.logDebug(
                    `checked that ${cmd.varName} is ${cmd.expectedValue}`
                );
                break;
            }
            case CommandType.Erase: {
                let cmd = cmd_ as EraseCommand;
                onProgress("wipe", cmd.partition, totalProgress);
                // avb_custom_key is required to be erased before flashing
                if (wipe || cmd.partition === "avb_custom_key") {
                    await device.runCommand(`erase:${cmd.partition}`);
                } else {
                    common.logDebug(
                        `skipped EraseCommand for ${cmd.partition} since "wipe" param is false`
                    );
                }
                break;
            }
            case CommandType.Flash: {
                let cmd = cmd_ as FlashCommand;
                let fileEntry = zipEntries.get(cmd.fileName)!;

                let progressCallback = (progress: number) => {
                    onProgress(
                        "flash",
                        cmd.fileName,
                        totalProgress +
                            progress *
                                (fileEntry.uncompressedSize /
                                    flashScript.totalFlashBytes)
                    );
                };

                await device.flashZipEntry(
                    cmd.partition,
                    cmd.slot,
                    fileEntry,
                    progressCallback
                );

                flashedBytes += fileEntry.uncompressedSize;
                break;
            }
            case CommandType.MaybeCancelSnapshotUpdate: {
                let status = await device.getVariable("snapshot-update-status");
                if (status !== null && status !== "none") {
                    await device.runCommand("snapshot-update:cancel");
                }
                break;
            }
            case CommandType.RebootBootloader: {
                onProgress("reboot", "device", totalProgress);
                await tryReboot(device, "bootloader", onReconnect);
                break;
            }
            case CommandType.RunCmd: {
                let cmd = cmd_ as RunCmdCommand;
                await device.runCommand(cmd.command);
                break;
            }
            case CommandType.ToggleActiveSlot: {
                let curSlot = await device.getVariable("current-slot");
                await device.runCommand("set_active:" + getOtherSlot(curSlot));
                break;
            }
            default: {
                throw new Error("unknown command: " + cmd_.type);
            }
        }
    }
    common.logDebug("flashOptimizedFactoryZip() has completed");
}

class FlashScript {
    public totalFlashBytes: number;

    constructor(
        readonly zipEntries: Map<string, Entry>,
        readonly commands: Command[]
    ) {
        let totalBytes = 0;
        for (let cmd of commands) {
            if (cmd.type === CommandType.Flash) {
                let flashCmd = cmd as FlashCommand;
                let entry = zipEntries.get(flashCmd.fileName)!;
                totalBytes += entry.uncompressedSize;
            }
        }
        this.totalFlashBytes = totalBytes;
    }

    static async parse(zipEntries: Map<string, Entry>): Promise<FlashScript> {
        let scriptEntry: Entry | undefined = undefined;
        for (let [name, entry] of zipEntries) {
            if (name.endsWith("/script.txt")) {
                scriptEntry = entry;
                break;
            }
        }
        if (scriptEntry === undefined) {
            throw new Error("script.txt not found");
        }
        // name of outer dir plus "/"
        let entryNamePrefix = scriptEntry.filename.slice(
            0,
            -"script.txt".length
        );

        let scriptString = await common.zipGetEntryAsString(scriptEntry);
        common.logDebug("script.txt:\n" + scriptString);
        let scriptLines: string[] = scriptString.split("\n");

        let commands: Command[] = [];
        for (let line of scriptLines) {
            if (line.length === 0 || line.startsWith("#")) {
                continue;
            }

            let tokens = line.split(" ");
            let name = tokens[0];
            let cmd: Command;
            let numTokens: number;
            switch (name) {
                case "check-requirements":
                    cmd = {
                        type: CommandType.CheckRequirements,
                        fileName: entryNamePrefix + tokens[1],
                    } as CheckRequirementsCommand;
                    numTokens = 2;
                    break;
                case "check-var":
                    cmd = {
                        type: CommandType.CheckVar,
                        varName: tokens[1],
                        expectedValue: tokens[2],
                    } as CheckVarCommand;
                    numTokens = 3;
                    break;
                case "erase":
                    cmd = {
                        type: CommandType.Erase,
                        partition: tokens[1],
                    } as EraseCommand;
                    numTokens = 2;
                    break;
                case "flash":
                    let flashCmd = {
                        type: CommandType.Flash,
                        partition: tokens[1],
                        fileName: entryNamePrefix + tokens[2],
                    } as FlashCommand;
                    cmd = flashCmd;
                    if (tokens.length > 3) {
                        if (tokens[3] === "other-slot") {
                            flashCmd.slot = PartitionSlot.Other;
                        } else {
                            throw new Error("invalid command: " + line);
                        }
                        numTokens = 4;
                    } else {
                        flashCmd.slot = PartitionSlot.Current;
                        numTokens = 3;
                    }
                    break;
                case "maybe-cancel-snapshot-update":
                    cmd = {
                        type: CommandType.MaybeCancelSnapshotUpdate,
                    } as Command;
                    numTokens = 1;
                    break;
                case "reboot-bootloader":
                    cmd = {
                        type: CommandType.RebootBootloader,
                    } as Command;
                    numTokens = 1;
                    break;
                case "run-cmd":
                    cmd = {
                        type: CommandType.RunCmd,
                        command: line.substring(name.length + 1),
                    } as RunCmdCommand;
                    numTokens = tokens.length;
                    break;
                case "toggle-active-slot":
                    cmd = {
                        type: CommandType.ToggleActiveSlot,
                    } as Command;
                    numTokens = 1;
                    break;
                default:
                    throw new Error("unknown command " + line);
            }
            if (tokens.length !== numTokens) {
                throw new Error(`invalid command ${line}`);
            }
            commands.push(cmd);
        }

        return new FlashScript(zipEntries, commands);
    }
}
