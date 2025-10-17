#!/bin/bash

# DMARC Report Viewer - Development Startup Script

echo "🚀 Starting DMARC Report Viewer in Development Mode"
echo "=================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check if we're in the right directory
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo "❌ Please run this script from the project root directory."
    exit 1
fi

# Backend setup
echo "🔧 Setting up backend..."
cd backend

if [ ! -f ".env" ]; then
    echo "📝 Creating backend .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit backend/.env with your IMAP credentials before starting the server."
fi

if [ ! -d "node_modules" ]; then
    echo "📦 Installing backend dependencies..."
    npm install
fi

echo "🗄️  Setting up database..."
npm run db:push > /dev/null 2>&1
npm run db:generate > /dev/null 2>&1

# Frontend setup
echo "🔧 Setting up frontend..."
cd ../frontend

if [ ! -d "node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    npm install
fi

# Start services
echo ""
echo "🚀 Starting services..."
echo "📍 Backend API: http://localhost:3000"
echo "📍 Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Start backend in background
cd ../backend
npm run dev &
BACKEND_PID=$!

# Start frontend in background
cd ../frontend
npm run dev &
FRONTEND_PID=$!

# Wait for Ctrl+C
trap "echo ''; echo '🛑 Stopping services...'; kill $BACKEND_PID $FRONTEND_PID; exit 0" INT

# Keep script running
wait