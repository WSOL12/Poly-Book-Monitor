# Kill every Poly-Book-Monitor monitor / watch process, then exit.
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    ($_.CommandLine -like '*Poly-Book-Monitor*src/index.ts*') -or
    ($_.CommandLine -like '*Poly-Book-Monitor*src\index.ts*') -or
    ($_.CommandLine -like '*Poly-Book-Monitor*watch-monitor-2h*') -or
    ($_.CommandLine -like '*Poly-Book-Monitor*npm-cli.js*run monitor*')
  )
}
foreach ($p in $procs) {
  Write-Output "kill $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output "done"
