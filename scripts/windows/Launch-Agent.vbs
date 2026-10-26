Option Explicit
Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File """ & WScript.Arguments(0) & """ -DataDir """ & WScript.Arguments(1) & """"
result = shell.Run(command, 0, True)
WScript.Quit result
