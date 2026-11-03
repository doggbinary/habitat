@echo off
rem Double-click to run the full version of Habitat, with your own packs.
rem Keep this window open while you use it; close it to stop.
rem On the iPad, open the "Network" address shown below (your Wi-Fi one).
rem It ends in :5173 unless that window says the port is already in use.
rem The first time, Windows may ask whether Node.js can use the network:
rem allow it on private networks.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run full
pause
