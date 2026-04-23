import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath } from "./util.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TITLE = "Choose repo folder for Orbit board";

export function folderPickerCommands(platform = process.platform, title = DEFAULT_TITLE) {
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`]
      }
    ];
  }

  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-STA",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
            `$dialog.Description = ${JSON.stringify(title)}`,
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
            "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
            "  Write-Output $dialog.SelectedPath",
            "}"
          ].join("; ")
        ]
      }
    ];
  }

  return [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title", title]
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", ".", title]
    }
  ];
}

function isMissingCommand(error) {
  return error?.code === "ENOENT";
}

function isPickerCancel(error) {
  const stderr = String(error?.stderr || "");
  return error?.code === 1 && /cancel|user canceled|user cancelled/i.test(stderr);
}

export async function pickFolder(options = {}) {
  const platform = options.platform || process.platform;
  const title = options.title || DEFAULT_TITLE;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const commands = folderPickerCommands(platform, title);
  let missingCommands = 0;

  for (const spec of commands) {
    try {
      const result = await execFileImpl(spec.command, spec.args, {
        encoding: "utf8",
        timeout: 120000,
        windowsHide: false
      });
      const selectedPath = normalizePath(String(result.stdout || "").trim());
      return selectedPath ? { path: selectedPath } : { canceled: true };
    } catch (error) {
      if (isMissingCommand(error)) {
        missingCommands += 1;
        continue;
      }
      if (isPickerCancel(error)) return { canceled: true };
      throw error;
    }
  }

  if (missingCommands === commands.length) {
    return { unsupported: true };
  }

  return { canceled: true };
}
