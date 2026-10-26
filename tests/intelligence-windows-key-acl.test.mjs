import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(
    `writer key DACL setup runs without audit privilege in ${shell}`,
    {
      skip: process.platform !== "win32",
    },
    (t) => {
      const available = spawnSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$PSVersionTable.PSVersion.ToString()",
        ],
        { windowsHide: true },
      );
      if (available.error?.code === "ENOENT" && shell === "pwsh.exe") {
        t.skip(
          "PowerShell 7 is not installed; Windows PowerShell 5.1 is tested separately",
        );
        return;
      }
      assert.equal(
        available.status,
        0,
        `${shell} must be available for this Windows verification`,
      );
      const dir = mkdtempSync(join(tmpdir(), "ritm-key-acl-test-"));
      const file = join(dir, "verify.ps1");
      const source = readFileSync(
        new URL("../scripts/windows/Enable-FormulaRepair.ps1", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("# Start key DACL setup.");
      const end = source.indexOf("# End key DACL setup.", start);
      assert.ok(
        start >= 0 && end > start,
        "exercise the actual key ACL setup block",
      );
      const setup = source.slice(start, end);
      writeFileSync(
        file,
        "\uFEFF" +
          `
$ErrorActionPreference = 'Stop'
$errors = $null
[void][Management.Automation.Language.Parser]::ParseFile('${fileURLToPath(new URL("../scripts/windows/Enable-FormulaRepair.ps1", import.meta.url)).replace(/'/g, "''")}', [ref]$null, [ref]$errors)
if ($errors.Count) { throw 'Owner setup script has PowerShell syntax errors' }
$dest = Join-Path $PSScriptRoot 'dummy-key.txt'
Set-Content -LiteralPath $dest -Value 'synthetic test data; no key'
$allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
$before = Get-Acl -LiteralPath $dest
${setup}
& icacls.exe $dest '/grant' '*S-1-1-0:(R)' '/Q' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot add the synthetic unwanted permission' }
${setup}
${setup}
$after = Get-Acl -LiteralPath $dest
if ($before.Owner -ne $after.Owner -or $before.Group -ne $after.Group) { throw 'DACL setup changed owner or group' }
Write-Output 'DACL verification passed'
`,
        "utf8",
      );
      try {
        const result = spawnSync(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            file,
          ],
          {
            windowsHide: true,
            encoding: "utf8",
            timeout: 20000,
            env:
              shell === "powershell.exe"
                ? {
                    ...process.env,
                    PSModulePath: join(
                      process.env.SystemRoot,
                      "System32",
                      "WindowsPowerShell",
                      "v1.0",
                      "Modules",
                    ),
                  }
                : process.env,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /DACL verification passed/);
      } finally {
        assert.equal(
          dirname(resolve(dir)),
          resolve(tmpdir()),
          "delete only the explicitly created test directory",
        );
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
