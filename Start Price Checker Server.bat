@echo off
setlocal enabledelayedexpansion
title Price Checker Server
cd /d "%~dp0"

REM ---- find a working Python on this PC ----
set PYCMD=
where py >nul 2>nul
if !ERRORLEVEL!==0 (
    py -3 --version >nul 2>nul
    if !ERRORLEVEL!==0 set PYCMD=py -3
)
if "!PYCMD!"=="" (
    where python >nul 2>nul
    if !ERRORLEVEL!==0 set PYCMD=python
)
if "!PYCMD!"=="" (
    color 4F
    echo.
    echo  ============================================================
    echo   Python is not installed on this computer.
    echo   Install it from https://www.python.org/downloads/ first,
    echo   ticking "Add python.exe to PATH" during install.
    echo   Then double-click this file again.
    echo  ============================================================
    echo.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo   Price Checker Server
echo  ============================================================
echo.

REM ---- HTTPS if a cert is present (needed for camera scanning),
REM      otherwise fall back to plain HTTP -- typing barcodes and
REM      Bluetooth/OTG scanners still work fine over HTTP, only the
REM      phone's camera button won't. See HTTPS-SETUP.md.
if exist "cert.pem" if exist "key.pem" (
    !PYCMD! serve_https.py
) else (
    echo  No cert.pem/key.pem found here -- serving over plain HTTP.
    echo  Camera scanning needs HTTPS: run make_cert.py in the
    echo  pricetag_tool folder, then re-open this window.
    echo.
    !PYCMD! -m http.server 8080
)

echo.
echo  Server stopped.
pause
