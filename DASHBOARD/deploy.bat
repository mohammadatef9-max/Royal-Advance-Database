@echo off
REM ============================================================
REM  One-click deploy for the dashboard.
REM
REM  1. Saves a snapshot in the local git history (this folder)
REM  2. Copies the site files into the GitHub repo clone
REM     (Documents\Claude\RoyalAdvance-deploy\DASHBOARD)
REM  3. Pushes to GitHub Pages
REM
REM  Live URL: https://mohammadatef9-max.github.io/Royal-Advance-Database/DASHBOARD/main_app.html
REM ============================================================
setlocal
set DEPLOY=C:\Users\USER\Documents\Claude\RoyalAdvance-deploy

cd /d "%~dp0"

REM --- 1. local history snapshot ---
git add -A
git commit -m "Site update %date% %time%" >nul 2>&1

REM --- 2. sync site files into the repo clone (mirror: removes stale files) ---
robocopy "%~dp0." "%DEPLOY%\DASHBOARD" *.html *.js *.png /MIR /XD .git KeyPlan /NJH /NJS /NDL /NFL
if errorlevel 8 (
  echo.
  echo COPY FAILED - deployment stopped.
  pause
  exit /b 1
)

REM --- 3. commit + push from the clone ---
cd /d "%DEPLOY%"
git add -A
git commit -m "Dashboard update %date% %time%"
git push origin main
if errorlevel 1 (
  echo.
  echo PUSH FAILED - check your internet connection or GitHub login.
  pause
  exit /b 1
)
echo.
echo Deployed successfully. Live in about 1 minute at:
echo https://mohammadatef9-max.github.io/Royal-Advance-Database/DASHBOARD/main_app.html
timeout /t 8
