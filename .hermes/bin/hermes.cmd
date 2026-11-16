@echo off
if "%~1"=="--print-runtime-command" call :print_runtime %2 %3 %4 %5 %6 %7 %8 %9 & exit /b 0
if "%~1"=="--run-module" call :run_module %2 %3 %4 %5 %6 %7 %8 %9 & exit /b 0

set "PYTHONPATH=C:\Users\z7203\grok\minAgent;C:\Users\z7203\grok\minAgent\.hermes;C:\Users\z7203\AppData\Local\Programs\Python\Python311\Lib\site-packages"
set "HERMES_DISABLE_LAZY_INSTALLS=1"
"C:\Users\z7203\AppData\Local\Programs\Python\Python311\python.exe" -m hermes_cli.main %*
exit /b %ERRORLEVEL%

:print_runtime
"C:\Users\z7203\AppData\Local\Programs\Python\Python311\python.exe" -c "import json,sys; print(json.dumps([r'C:\Users\z7203\AppData\Local\Programs\Python\Python311\python.exe','-m','hermes_cli.main']+sys.argv[1:]))" %*
exit /b 0

:run_module
set "HERMES_MODULE=%~1"
shift
set "PYTHONPATH=C:\Users\z7203\grok\minAgent;C:\Users\z7203\grok\minAgent\.hermes;C:\Users\z7203\AppData\Local\Programs\Python\Python311\Lib\site-packages"
set "HERMES_DISABLE_LAZY_INSTALLS=1"
"C:\Users\z7203\AppData\Local\Programs\Python\Python311\python.exe" -m %HERMES_MODULE% %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
