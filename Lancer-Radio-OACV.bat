@echo off
title Radio OACV
cd /d "%~dp0"
setlocal

echo.
echo   ==============================================
echo     RADIO OACV
echo   ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :sansnode

if not exist ".env" (
  echo   Premiere utilisation : configuration du serveur.
  echo   Vous allez choisir vos identifiants d'administration.
  echo   Pour le compte de votre collegue : appuyez sur Entree, vous
  echo   pourrez l'ajouter plus tard avec  npm run add-account
  echo.
  node tools\setup.js
  if not exist ".env" goto :sansenv
  echo.
)

echo   Demarrage du serveur...
start "Radio OACV - serveur" /min cmd /k "node server\server.js"
timeout /t 3 /nobreak >nul

start "" http://127.0.0.1:8123/
echo.
echo   Site public    : http://127.0.0.1:8123/
echo   Administration : http://127.0.0.1:8123/admin
echo.
echo   Le serveur tourne dans la fenetre "Radio OACV - serveur"
echo   (reduite dans la barre des taches). Pour l'arreter : Ctrl+C dedans.
echo.
echo   Ajouter ou changer le compte de votre collegue :
echo     npm run add-account
echo   (puis relancez ce fichier pour appliquer)
echo.
pause
exit /b 0

:sansenv
echo.
echo   La configuration n'a pas ete creee : la radio ne peut pas demarrer.
pause
exit /b 1

:sansnode
echo   Node.js n'est pas installe : demarrage en mode simple.
echo   Le site fonctionne, mais sans administration ni annonces.
echo   Pour tout activer : installez Node.js 18 ou plus (nodejs.org).
echo.
start "" /min cmd /c "py -m http.server 8123 --bind 127.0.0.1"
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:8123/index.html
echo   La radio est lancee dans ton navigateur !
echo   (laisse cette fenetre ouverte en arriere-plan)
echo.
pause
exit /b 0
