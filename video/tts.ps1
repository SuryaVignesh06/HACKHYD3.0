# Narration for the FRIDAY video: Windows' built-in OneCore voices, offline.
# Reads a JSON job list [{ voice, text, out }] and writes one WAV per line.
param([string]$Jobs)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
foreach ($job in (Get-Content -Raw -Path $Jobs | ConvertFrom-Json)) {
  $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $job.voice } | Select-Object -First 1
  if ($null -eq $voice) { throw "Voice not installed: $($job.voice)" }
  $synth.Voice = $voice
  try { $synth.Options.SpeakingRate = [double]$job.rate } catch { }
  $stream = Await ($synth.SynthesizeTextToStreamAsync($job.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($job.out, $bytes)
  $reader.Dispose(); $stream.Dispose()
  Write-Output "OK $($job.out)"
}
