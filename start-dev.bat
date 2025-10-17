@echo off
echo 🚀 Starting DMARC Report Viewer in Development Mode
echo ==================================================

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed. Please install Node.js 18+ first.
    pause
    exit /b 1
)

REM Check if we're in the right directory
if not exist "backend" (
    echo ❌ Please run this script from the project root directory.
    pause
    exit /b 1
)
if not exist "frontend" (
    echo ❌ Please run this script from the project root directory.
    pause
    exit /b 1
)

REM Backend setup
echo 🔧 Setting up backend...
cd backend

if not exist ".env" (
    echo 📝 Creating backend .env file from template...
    copy .env.example .env >nul
    echo ⚠️  Please edit backend/.env with your IMAP credentials before starting the server.
)

if not exist "node_modules" (
    echo 📦 Installing backend dependencies...
    call npm install
)

echo 🗄️  Setting up database...
call npm run db:push >nul 2>&1
call npm run db:generate >nul 2>&1

REM Frontend setup
echo 🔧 Setting up frontend...
cd ..\frontend

if not exist "node_modules" (
    echo 📦 Installing frontend dependencies...
    call npm install
)

REM Start services
echo.
echo 🚀 Starting services...
echo 📍 Backend API: http://localhost:3000
echo 📍 Frontend: http://localhost:5173
echo.
echo Press Ctrl+C to stop all services
echo.

REM Start backend
cd ..\backend
start "DMARC Backend" cmd /k "npm run dev"

REM Start frontend
cd ..\frontend
start "DMARC Frontend" cmd /k "npm run dev"

echo ✅ Services started in separate windows
echo Close the command windows to stop the services
pause