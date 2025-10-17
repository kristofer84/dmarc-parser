# 📨 DMARC Report Viewer

A full-stack application for automatically processing DMARC reports from email and providing a web-based dashboard for analysis.

## 🚀 Features

- **Automated Email Processing**: Fetches DMARC reports from IMAP email accounts
- **XML Parsing**: Processes DMARC XML reports with validation
- **REST API**: Provides endpoints for reports and summary statistics
- **Interactive Dashboard**: Vue.js frontend with charts and analytics
- **Report Management**: Sortable tables with filtering and pagination
- **Real-time Updates**: Automatic processing with scheduling

## 🏗️ Architecture

### Backend (Node.js + Express)
- **Runtime**: Node.js with ESM modules
- **Framework**: Express.js with TypeScript
- **Database**: SQLite with Prisma ORM
- **Email**: node-imap for IMAP connectivity
- **Parsing**: xml2js for DMARC XML processing

### Frontend (Vue 3)
- **Framework**: Vue 3 with Composition API
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Charts**: Chart.js for data visualization
- **Build**: Vite for fast development

## 📋 Prerequisites

- Node.js 18+ 
- npm or yarn
- IMAP email account with DMARC reports

## 🛠️ Installation

### 1. Clone the repository
```bash
git clone <repository-url>
cd dmarc-report-viewer
```

### 2. Backend Setup
```bash
cd backend
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your IMAP credentials
# IMAP_HOST=imap.example.com
# IMAP_PORT=993
# IMAP_USER=dmarc@example.com
# IMAP_PASSWORD=your_password
# DATABASE_URL=file:./data.db

# Initialize database
npm run db:push
npm run db:generate

# Optional: Seed with sample data
npm run db:seed
```

### 3. Frontend Setup
```bash
cd ../frontend
npm install

# Copy environment template (optional)
cp .env.example .env
```

## 🚀 Running the Application

### Development Mode

1. **Start the backend server**:
```bash
cd backend
npm run dev
```
The API will be available at `http://localhost:3000`

2. **Start the frontend development server**:
```bash
cd frontend
npm run dev
```
The web interface will be available at `http://localhost:5173`

### Production Mode

1. **Build and start backend**:
```bash
cd backend
npm run build
npm start
```

2. **Build frontend**:
```bash
cd frontend
npm run build
```
Serve the `dist` folder with your preferred web server.

## 📧 Email Processing

### Manual Processing
Process emails manually using the CLI:
```bash
cd backend
npm run process-emails
```

### Automatic Processing
In production mode, the application automatically processes emails every 5 minutes.

## 🔧 API Endpoints

### Reports
- `GET /api/reports` - List all reports with filtering and pagination
- `GET /api/reports/:id` - Get detailed report information

### Summary
- `GET /api/summary` - Get dashboard statistics and analytics

### Health
- `GET /health` - Application health check

## 📊 Dashboard Features

### Overview Dashboard
- Total reports and messages processed
- SPF and DKIM pass rates
- Policy action distribution
- Trend analysis over time
- Top reporting organizations
- Top source IP addresses

### Reports List
- Sortable table with all reports
- Filter by domain and organization
- Pagination support
- Click to view detailed report

### Report Details
- Complete authentication breakdown
- Source IP analysis
- Message volume statistics
- Authentication success rates

## 🗄️ Database Schema

### Reports Table
- Domain, organization, email
- Report period (start/end dates)
- Metadata and timestamps

### Records Table
- Source IP addresses
- Message counts
- SPF/DKIM results
- Policy dispositions
- Header information

## 🔒 Security Features

- Input validation and sanitization
- Rate limiting on API endpoints
- SQL injection prevention via Prisma
- Environment-based configuration
- Error handling and logging

## 🛠️ Development

### Backend Scripts
```bash
npm run dev          # Development server with hot reload
npm run build        # Build TypeScript to JavaScript
npm run start        # Start production server
npm run db:generate  # Generate Prisma client
npm run db:push      # Push schema to database
npm run db:migrate   # Run database migrations
npm run db:seed      # Seed database with sample data
npm run process-emails # Manual email processing
```

### Frontend Scripts
```bash
npm run dev          # Development server
npm run build        # Production build
npm run preview      # Preview production build
npm run type-check   # TypeScript type checking
```

## 📝 Configuration

### Environment Variables

#### Backend (.env)
```env
# IMAP Configuration
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=dmarc@example.com
IMAP_PASSWORD=your_password

# Database
DATABASE_URL=file:./data.db

# Server
PORT=3000
NODE_ENV=development
```

#### Frontend (.env)
```env
# API Configuration
VITE_API_BASE_URL=http://localhost:3000/api
```

## 🐛 Troubleshooting

### Common Issues

1. **IMAP Connection Failed**
   - Verify IMAP credentials and server settings
   - Check firewall and network connectivity
   - Ensure IMAP is enabled on email account

2. **Database Errors**
   - Run `npm run db:push` to create tables
   - Check DATABASE_URL format
   - Ensure write permissions for SQLite file

3. **Frontend API Errors**
   - Verify backend server is running
   - Check VITE_API_BASE_URL configuration
   - Review browser network tab for CORS issues

### Logs and Debugging
- Backend logs are output to console
- Check browser developer tools for frontend errors
- Use `NODE_ENV=development` for detailed error messages

## 📈 Performance Considerations

- Database indexes on frequently queried fields
- API pagination to limit response sizes
- Frontend lazy loading and code splitting
- Chart.js optimization for large datasets
- IMAP connection pooling and retry logic

## 🔄 Deployment

### Docker (Optional)
Create Dockerfile for containerized deployment:

```dockerfile
# Backend Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
COPY prisma ./prisma
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Setup
- Configure production IMAP credentials
- Set up proper database backup strategy
- Configure reverse proxy (nginx) for frontend
- Set up SSL certificates for HTTPS
- Configure monitoring and logging

## 📄 License

This project is licensed under the MIT License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions:
- Check the troubleshooting section
- Review application logs
- Create an issue in the repository