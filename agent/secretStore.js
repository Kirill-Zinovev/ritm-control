import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const DPAPI_SOURCE = `using System;
using System.Runtime.InteropServices;
public static class RitmDpapi {
  [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int Length; public IntPtr Data; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);
  [DllImport("crypt32.dll", SetLastError=true)] private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LocalFree(IntPtr memory);
  private static byte[] Copy(DataBlob blob) { var bytes = new byte[blob.Length]; Marshal.Copy(blob.Data, bytes, 0, blob.Length); return bytes; }
  public static byte[] Protect(byte[] bytes) { var input = new DataBlob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) }; Marshal.Copy(bytes, 0, input.Data, bytes.Length); try { DataBlob output; if (!CryptProtectData(ref input, "RITM Assistant", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); try { return Copy(output); } finally { LocalFree(output.Data); } } finally { Marshal.FreeHGlobal(input.Data); } }
  public static byte[] Unprotect(byte[] bytes) { var input = new DataBlob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) }; Marshal.Copy(bytes, 0, input.Data, bytes.Length); try { IntPtr description; DataBlob output; if (!CryptUnprotectData(ref input, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); try { return Copy(output); } finally { LocalFree(output.Data); if (description != IntPtr.Zero) LocalFree(description); } } finally { Marshal.FreeHGlobal(input.Data); } }
}`;
const ENCRYPT_SCRIPT = `$ErrorActionPreference='Stop'; $source=@'\n${DPAPI_SOURCE}\n'@; Add-Type -TypeDefinition $source; $plain=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([RitmDpapi]::Protect([Text.Encoding]::UTF8.GetBytes($plain)))`;
const DECRYPT_SCRIPT = `$ErrorActionPreference='Stop'; $source=@'\n${DPAPI_SOURCE}\n'@; Add-Type -TypeDefinition $source; $cipher=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($cipher); [Text.Encoding]::UTF8.GetString([RitmDpapi]::Unprotect($bytes))`;
function ps(command, input) {
  if (process.platform !== "win32")
    throw new Error("Хранилище DPAPI доступно только в Windows.");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "Windows DPAPI завершился с ошибкой: " +
        String(result.stderr || result.error?.message || "неизвестная ошибка").slice(0, 200),
    );
  return result.stdout.trim();
}

export class LocalSecretStore {
  constructor(
    dataDir,
    {
      encrypt = (value) => ps(ENCRYPT_SCRIPT, value),
      decrypt = (value) => ps(DECRYPT_SCRIPT, value),
    } = {},
  ) {
    this.file = path.join(dataDir, "assistant-secrets.dpapi");
    this.encryptValue = encrypt;
    this.decryptValue = decrypt;
  }
  async read() {
    try {
      const cipher = (await readFile(this.file, "utf8")).trim();
      if (!cipher) return {};
      const json = await this.decryptValue(cipher);
      const value = JSON.parse(json);
      return value && typeof value === "object" ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error("Не удалось расшифровать локальные секреты владельца.");
    }
  }
  async write(value) {
    const cipher = await this.encryptValue(JSON.stringify(value));
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, cipher + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  async clear() {
    try {
      await unlink(this.file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
