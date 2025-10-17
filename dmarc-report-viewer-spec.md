# 📨 DMARC Report Viewer – Specification

## 🧩 Overview

**Purpose:**  
This application automatically fetches DMARC reports from a designated email inbox, marks them as read, parses the XML content, and stores structured data in a database.  
It also provides a simple Vue-based interface where users can view statistics, tables, and alerts derived from the reports.

---

## ⚙️ Technical Architecture

### Backend

| Component | Choice |
|------------|---------|
| Runtime | Node.js (ESM) |
| Server | Express |
| ORM | Prisma |
| Database | SQLite (local) |
| Email Client | node-imap or imap-simple |
| Parser | mailparser + xml2js |
| Configuration | dotenv (.env file) |

**Structure:**
```
backend/
 ├── src/
 │    ├── index.ts
 │    ├── imapClient.ts
 │    ├── parseDmarc.ts
 │    ├── db/
 │    │    └── prisma.ts
 │    └── routes/
 │         ├── reports.ts
 │         └── summary.ts
 ├── prisma/
 │    └── schema.prisma
 ├── package.json
 └── .env
```

---

### Frontend (Vue 3)

| Component | Choice |
|------------|---------|
| Framework | Vue 3 + Vite |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Structure | <template>, <script setup lang="ts">, <style scoped> |

**Structure:**
```
frontend/
 ├── src/
 │    ├── views/
 │    │    ├── DashboardView.vue
 │    │    └── ReportListView.vue
 │    ├── components/
 │    │    ├── SummaryCard.vue
 │    │    └── ChartView.vue
 │    └── api/
 │         └── reports.ts
 ├── vite.config.ts
```

---

## 🧠 Core Functionality

### Email Handling
- Connect to IMAP server using credentials from `.env`.
- Filter incoming messages for DMARC XML attachments.
- Download and parse XML attachments.
- Mark processed emails as read.

### Parsing & Storage
- Parse XML to extract core DMARC data:
  - Source organization (e.g., Google, Microsoft, Yahoo)
  - Report period (start–end)
  - Domain
  - SPF and DKIM results
  - IP addresses and message volumes
  - Policy actions (none, quarantine, reject)
- Store data in the database via Prisma.

### REST API Endpoints
| Method | Endpoint | Description |
|---------|-----------|-------------|
| `GET` | `/reports` | List all parsed DMARC reports |
| `GET` | `/reports/:id` | Fetch details of a specific report |
| `GET` | `/summary` | Aggregated statistics for dashboard |

---

## 📊 Frontend Views

### Dashboard View
Displays high-level aggregated data such as:
- Total reports processed
- SPF/DKIM pass rates
- Policy actions summary
- Chart showing volume and failure trends

### Report List View
Shows detailed report entries with sortable columns:
| Field | Description |
|--------|--------------|
| Domain | The monitored domain |
| Report period | Date range of the report |
| Source | Reporting organization |
| Total volume | Number of messages analyzed |
| SPF pass rate | Percentage passing SPF |
| DKIM pass rate | Percentage passing DKIM |
| Policy action | none / quarantine / reject |

### Suggested Charts
- Line chart: Message volume and fail rate over time  
- Pie chart: Distribution of policy actions  
- Bar chart: Top 10 sending IPs  

---

## 🔒 Environment Variables (.env)
```
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=dmarc@example.com
IMAP_PASSWORD=secret
DATABASE_URL=file:./data.db
```

---

## 🧱 MVP Goals

1. Fetch and process the last 50 unread DMARC reports via IMAP  
2. Parse and store data in SQLite using Prisma  
3. Implement REST API endpoints (`/reports`, `/summary`)  
4. Create Vue-based dashboard and table views using Tailwind  
5. Enable configuration through `.env`  
