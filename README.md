# 📨 DMARC Report Viewer

A full-stack application for automatically processing DMARC reports from email and providing a web-based dashboard for analysis.

## 🚀 Deploy your own

No build required - the image is published multi-arch (`amd64` + `arm64`, so a Raspberry Pi
gets a native image):

```bash
cp .env.example .env      # ADMIN_EMAIL, ADMIN_PASSWORD, and the mailbox that gets reports
docker compose -f compose.quickstart.yml up -d
```

Then open `http://localhost:8096` and sign in. Plain Docker works just as well:

```bash
docker run -d --name dmarc-parser -p 8096:8096 \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='something-long' \
  -v dmarc-data:/app/data ghcr.io/kristofer84/dmarc-parser:latest
```

One container serves the API *and* the web UI on one port: same origin, so there is no CORS
to configure and no second service to keep in step. Published images carry build
provenance:

```bash
gh attestation verify oci://ghcr.io/kristofer84/dmarc-parser:latest --repo kristofer84/dmarc-parser
```

| Variable | What it is |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator, created only when the users table is empty. Without a password one is generated and printed to the log once. |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` | The mailbox that receives `rua`/`ruf` reports. Entirely optional: anything left out can be set in the UI under *Administration → Settings*, per field, where the environment keeps precedence. **Test connection** there reports the real server's answer before you save. |
| `COOKIE_SECURE` | `true` once TLS is in front of it, otherwise the session cookie is dropped over http. |
| `PUBLIC_ORIGIN` | Only needed when a browser calls the API from a different origin than the UI. |
| `DATABASE_URL` | Defaults to `file:/app/data/data.db`, inside the mounted volume. |

Appearance is configurable per instance: *Administration → Settings → Branding* sets the
instance name and the accent colour (the whole palette derives from it at runtime), and the
header has a light/dark/system toggle that remembers the choice.

All state is the SQLite database in that volume - back it up and you have everything.
Before exposing it to the internet, put TLS in front and set `COOKIE_SECURE=true`;
[deploy/README.md](deploy/README.md) is the runbook (nginx, certificate, hardened env), and its
[§6-§8](deploy/README.md#6-backup) cover measured backup, restore and a restore drill.

Security: [SECURITY.md](SECURITY.md) for disclosure and what the code enforces. Compliance:
[docs/nis2.md](docs/nis2.md) maps NIS2 Art. 21 clause by clause to what this app does and, more
usefully, what it does not. Everything else is indexed in [docs/](docs/README.md).

## Licence

AGPL-3.0. Self-hosting it, modifying it and running it for your own organisation needs
nothing from you. The one obligation is the AGPL's network clause: if you offer a *modified*
version to other people over a network, you have to publish your source. A closed-source
hosted fork is not permitted.

## 🚀 Features

- **Automated Email Processing**: Fetches DMARC reports from IMAP email accounts
- **Aggregate (rua) reports**: XML parsing with validation, per-source-IP pass/fail breakdown
- **Forensic (ruf) reports**: per-message authentication failures, including the failing message's headers when the reporter attaches it
- **TLS-RPT reports**: SMTP TLS outcomes from senders (successes, failures and the reason for each failure), which is what tells you whether MTA-STS can be enforced
- **Nothing arriving silently dropped**: an attachment the parsers do not understand is listed in the processing log rather than disappearing
- **Both TLS-RPT transports**: reports arriving by mail are ingested directly; the reports an HTTPS collector stores on the mail host are pulled hourly by a small sync job that lives outside the container (so the app never holds an SSH key)
- **Multi-user with per-domain access**: administrators see everything, users see only the domains assigned to them
- **Passkeys and SSO, without giving up passwords**: WebAuthn sign-in, plus OIDC as an identity-only third way in
- **Persistent audit trail**: who changed what, from where, and whether it worked - with filters, CSV/JSON export and a SHA-256 digest over each export
- **Data retention**: per-dataset policies for aggregate reports, forensic reports and the audit log, with a preview of exactly what a run would delete
- **Safe to expose**: session authentication, login rate limiting and lockout, scoped queries
- **Honest health**: reports `unhealthy` when ingestion is broken instead of answering 200 from a process that has not stored a report in days
- **DNSSEC**: the domain check verifies the DS at the registrar against the keys in the zone (computing the digest, not trusting a tag), and the record generator prints the exact DS value to paste when enabling or rotating a key
- **Glossary**: every term the reports and DNS checks use, explained in-app at `/glossary`

## 🏗️ Architecture

Where each concern lives, and the gotcha attached to it, is in
[docs/where-things-live.md](docs/where-things-live.md) — read that before changing a subsystem.

### Backend (Node.js + Express)
- **Runtime**: Node.js with ESM modules
- **Framework**: Express.js with TypeScript
- **Database**: SQLite with Prisma ORM
- **Email**: node-imap for IMAP connectivity
- **Parsing**: xml2js for DMARC XML processing
- **Audit & retention**: append-only `audit_events` table written by one middleware; scheduled pruning driven by the `data.*` settings

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
The web interface will be available at `http://localhost:8097`

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

Details, and how to report a problem, are in [SECURITY.md](SECURITY.md).

- Passkeys (WebAuthn) and OIDC sign-in; the password remains the recovery path
- scrypt password hashing; opaque server-side sessions storing only the token hash
- Login rate limiting and per-account lockout
- Queries scoped per domain (out-of-scope ids return 404, not 403)
- Persistent audit trail for authentication and every administrative change
- Input validation, Prisma parameterisation, environment-based configuration
- Provenance and SBOM attestations on published images

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

# Email processing scheduler
# Set to "false" to keep automatic checks off in development.
# Omit or set to "true" in production to enable scheduled polling.
ENABLE_SCHEDULED_EMAIL_PROCESSING=false
# EMAIL_PROCESSING_INTERVAL_MS=300000
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
FROM node:24-alpine
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