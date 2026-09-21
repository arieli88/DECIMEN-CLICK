@echo off
cd /d "%~dp0"
echo Starting local server at http://localhost:8080
echo Open: http://localhost:8080/decimen-sender.html
echo       http://localhost:8080/decimen-receiver.html
echo.
where py >nul 2>nul && (py -m http.server 8080 & goto :eof)
where python >nul 2>nul && (python -m http.server 8080 & goto :eof)
echo Python not found. You can still double-click the HTML files (file://).
pause
