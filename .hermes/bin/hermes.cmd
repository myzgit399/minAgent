@echo off
setlocal
for %%I in ("%~dp0..\..") do set "HERMES_REPO_ROOT=%%~fI"
if "%HERMES_PYTHON%"=="" set "HERMES_PYTHON=python"
set "HERMES_PYTHON_CMD=%HERMES_PYTHON%"
if /I "%HERMES_PYTHON%"=="python" (
  for /f "delims=" %%P in ('where python') do if not defined PY_RESOLVED set "PY_RESOLVED=%%P"
  if defined PY_RESOLVED set "HERMES_PYTHON_CMD=%PY_RESOLVED%"
)
set "PYTHONPATH=%HERMES_REPO_ROOT%;%HERMES_REPO_ROOT%\.hermes"
set "HERMES_DISABLE_LAZY_INSTALLS=1"

if "%~1"=="--print-runtime-command" call :print_runtime %2 %3 %4 %5 %6 %7 %8 %9 & exit /b 0
if "%~1"=="--run-module" call :run_module %2 %3 %4 %5 %6 %7 %8 %9 & exit /b 0

"%HERMES_PYTHON_CMD%" -m hermes_cli.main %*
exit /b %ERRORLEVEL%

:print_runtime
"%HERMES_PYTHON_CMD%" -c "import json,os,sys; print(json.dumps([os.environ['HERMES_PYTHON_CMD'],'-m','hermes_cli.main']+sys.argv[1:]))" %*
exit /b 0

:run_module
set "HERMES_MODULE=%~1"
shift
"%HERMES_PYTHON_CMD%" -m %HERMES_MODULE% %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
