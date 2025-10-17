# Requirements Document

## Introduction

The DMARC Report Viewer is an automated system that fetches DMARC reports from email inboxes, processes the XML data, stores it in a database, and provides a web-based interface for viewing statistics and detailed report information. This system helps organizations monitor their email authentication status and identify potential security issues through DMARC report analysis.

## Requirements

### Requirement 1

**User Story:** As a system administrator, I want the application to automatically fetch DMARC reports from my email inbox, so that I don't have to manually download and process them.

#### Acceptance Criteria

1. WHEN the system connects to an IMAP server THEN it SHALL authenticate using credentials from environment variables
2. WHEN the system scans the inbox THEN it SHALL identify emails containing DMARC XML attachments
3. WHEN a DMARC report email is found THEN the system SHALL download the XML attachment
4. WHEN an email is processed THEN the system SHALL mark it as read to avoid reprocessing
5. IF the IMAP connection fails THEN the system SHALL log the error and retry with exponential backoff

### Requirement 2

**User Story:** As a system administrator, I want DMARC XML reports to be parsed and stored in a structured format, so that I can analyze the data programmatically.

#### Acceptance Criteria

1. WHEN an XML attachment is downloaded THEN the system SHALL parse it to extract DMARC data
2. WHEN parsing XML THEN the system SHALL extract source organization, report period, domain, SPF results, DKIM results, IP addresses, message volumes, and policy actions
3. WHEN data is extracted THEN the system SHALL store it in a SQLite database using Prisma ORM
4. IF XML parsing fails THEN the system SHALL log the error and continue processing other reports
5. WHEN storing data THEN the system SHALL prevent duplicate reports from being stored

### Requirement 3

**User Story:** As a developer or external system, I want to access DMARC report data through REST API endpoints, so that I can integrate with other tools or build custom interfaces.

#### Acceptance Criteria

1. WHEN a GET request is made to /reports THEN the system SHALL return a list of all parsed DMARC reports
2. WHEN a GET request is made to /reports/:id THEN the system SHALL return detailed information for the specific report
3. WHEN a GET request is made to /summary THEN the system SHALL return aggregated statistics including total reports, pass rates, and policy actions
4. IF an invalid report ID is requested THEN the system SHALL return a 404 error
5. WHEN API responses are returned THEN they SHALL be in JSON format with proper HTTP status codes

### Requirement 4

**User Story:** As a security analyst, I want a web dashboard to view DMARC report statistics and trends, so that I can quickly assess my domain's email authentication status.

#### Acceptance Criteria

1. WHEN I access the dashboard THEN I SHALL see total reports processed, SPF/DKIM pass rates, and policy actions summary
2. WHEN viewing the dashboard THEN I SHALL see charts showing message volume and failure trends over time
3. WHEN I interact with charts THEN they SHALL be responsive and display tooltips with detailed information
4. IF no data is available THEN the dashboard SHALL display appropriate empty state messages
5. WHEN the dashboard loads THEN it SHALL fetch data from the backend API endpoints

### Requirement 5

**User Story:** As a security analyst, I want to view detailed DMARC report data in a sortable table format, so that I can investigate specific reports and identify patterns.

#### Acceptance Criteria

1. WHEN I access the report list view THEN I SHALL see a table with domain, report period, source, total volume, SPF pass rate, DKIM pass rate, and policy action columns
2. WHEN I click on column headers THEN the table SHALL sort by that column in ascending or descending order
3. WHEN I click on a report row THEN I SHALL be able to view detailed information for that specific report
4. IF there are many reports THEN the table SHALL support pagination
5. WHEN the table loads THEN it SHALL fetch data from the /reports API endpoint

### Requirement 6

**User Story:** As a system administrator, I want to configure the application through environment variables, so that I can deploy it in different environments without code changes.

#### Acceptance Criteria

1. WHEN the application starts THEN it SHALL read IMAP credentials from environment variables (IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD)
2. WHEN connecting to the database THEN it SHALL use the DATABASE_URL environment variable
3. IF required environment variables are missing THEN the application SHALL fail to start with a clear error message
4. WHEN environment variables are loaded THEN sensitive information SHALL not be logged or exposed
5. IF environment variables are invalid THEN the application SHALL validate them and provide helpful error messages