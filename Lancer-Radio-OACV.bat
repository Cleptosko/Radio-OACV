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

if exist ".env" goto :serveur

echo   Premiere utilisation : que voulez-vous faire ?
echo.
echo     [1] Ecouter la radio tout de suite (sans administration)
echo     [2] Configurer l'administration (comptes, annonces, banque)
echo.
choice /c 12 /n /m "  Votre choix [1] : "
if errorlevel 2 goto :config
goto :ecoute

:serveur
echo   Demarrage du serveur (site + administration)...
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

:ecoute
echo   Demarrage en mode ecoute (site public seul)...
echo.
echo   Pour activer plus tard l'administration (annonces, banque de
echo   musiques, programmation) :  npm run setup  puis relancez ce fichier.
echo.
start "Radio OACV - site" /min cmd /k "node tools\serve-site.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8123/index.html
echo   Le site est ouvert dans votre navigateur : appuyez sur Lecture.
echo   (gardez la fenetre "Radio OACV - site" ouverte ; Ctrl+C dedans pour arreter)
echo.
pause
exit /b 0

:config
echo.
echo   Configuration du serveur : vous allez choisir vos identifiants
echo   d'administration. Pour le compte de votre collegue : appuyez sur
echo   Entree, vous pourrez l'ajouter plus tard avec  npm run add-account
echo.
node tools\setup.js
if not exist ".env" goto :ecoute
echo.
goto :serveur

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
