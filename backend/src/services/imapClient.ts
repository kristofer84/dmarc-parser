import Imap from 'node-imap';
import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import { RufParser } from './rufParser.js';
import { resolveMailboxConfig, type MailboxConfig } from './mailboxConfig.js';

export interface EmailMessage {
  uid: number;
  subject: string;
  from: string;
  date: Date;
  attachments: EmailAttachment[];
  /** Message-ID of the mail itself, used to deduplicate forensic reports. */
  messageId?: string | null;
  /** Authentication-Results header of the mail itself, if the receiving MTA added one. */
  authenticationResults?: string | null;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Aggregate (rua) report unless marked otherwise. */
  kind?: 'aggregate' | 'forensic';
  /** For forensic reports: the message/rfc822 the failure is about, when attached. */
  reportedMessage?: Buffer | null;
}

export class ImapClient {
  /** Created on connect rather than in the constructor: the credentials may come from the
   * settings table, which can only be read asynchronously, and can change between cycles. */
  private imap!: Imap;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000; // Start with 1 second
  private readonly archiveMailbox = 'dmarc-archive';
  private archiveMailboxVerified = false;

  private createConnection(mailbox: MailboxConfig): void {
    this.imap = new Imap({
      user: mailbox.user,
      password: mailbox.password,
      host: mailbox.host,
      port: mailbox.port,
      tls: true,
      tlsOptions: {
        // Verifying is the default; only a self-signed server should turn it off.
        rejectUnauthorized: mailbox.verifyTls,
        servername: mailbox.host, // SNI, and the name the certificate is checked against
      },
      connTimeout: 60000, // 60 second connection timeout
      authTimeout: 30000, // 30 second auth timeout
      keepalive: {
        interval: 10000, // Send keepalive every 10 seconds
        idleInterval: 300000, // 5 minutes
        forceNoop: true,
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.imap.on('ready', () => {
      console.log('✅ IMAP connection ready');
      this.connected = true;
      this.retryCount = 0; // Reset retry count on successful connection
    });

    this.imap.on('error', (err: Error) => {
      console.error('❌ IMAP connection error:', err.message);
      console.error('❌ Error details:', {
        code: (err as any).code,
        errno: (err as any).errno,
        syscall: (err as any).syscall,
        stack: err.stack,
      });
      this.connected = false;
    });

    this.imap.on('end', () => {
      console.log('📪 IMAP connection ended');
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.imap) {
      const mailbox = await resolveMailboxConfig();

      if (!mailbox.configured || !mailbox.config) {
        throw new Error(
          `Mailbox is not configured yet (${mailbox.summary}) - set it under Administration → Settings`,
        );
      }

      this.createConnection(mailbox.config);
    }

    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('IMAP connection timeout'));
      }, 10000); // 10 second timeout

      this.imap.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.imap.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      try {
        this.imap.connect();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async connectWithRetry(): Promise<void> {
    // Start every cycle with a fresh retry budget. Without this reset a cycle that
    // exhausted its retries leaves retryCount at maxRetries, so the loop below never
    // runs again: the method resolves without connecting and every later cycle dies in
    // fetchMessages() with 'IMAP client not connected' until the container is restarted
    // (this is what happened after a transient EAI_AGAIN on 2026-10-07).
    this.retryCount = 0;

    while (this.retryCount < this.maxRetries) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.retryCount++;
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1); // Exponential backoff
        
        console.warn(`⚠️ IMAP connection attempt ${this.retryCount} failed. Retrying in ${delay}ms...`);
        
        if (this.retryCount >= this.maxRetries) {
          throw new Error(`IMAP connection failed after ${this.maxRetries} attempts: ${error}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Unreachable while maxRetries >= 1, but never fall through silently: a caller that
    // gets no error must be able to assume a connection exists.
    throw new Error(`IMAP connection failed after ${this.maxRetries} attempts`);
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.connected) {
        resolve();
        return;
      }

      const finalize = () => {
        this.imap.removeListener('end', onEnd);
        this.imap.removeListener('close', onClose);
        this.imap.removeListener('error', onError);
      };

      const complete = () => {
        clearTimeout(timeoutId);
        finalize();
        resolve();
      };

      const onEnd = () => {
        complete();
      };

      const onClose = () => {
        if (this.connected) {
          this.connected = false;
        }
        console.log('📪 IMAP connection closed');
        complete();
      };

      const onError = (error: Error) => {
        console.warn('⚠️ IMAP disconnect encountered an error:', error.message);
        complete();
      };

      const timeoutId = setTimeout(() => {
        console.warn('⚠️ IMAP disconnect timeout, continuing shutdown');
        complete();
      }, 5000);

      this.imap.once('end', onEnd);
      this.imap.once('close', onClose);
      this.imap.once('error', onError);

      try {
        this.imap.end();
      } catch (error) {
        console.warn('⚠️ Failed to end IMAP connection cleanly:', error instanceof Error ? error.message : error);
        complete();
      }
    });
  }

  async openInbox(): Promise<void> {
    return this.openMailbox('INBOX');
  }

  /**
   * Opens any mailbox. It is opened read-write so the caller can mark or move messages,
   * but nothing here changes flags on its own.
   */
  async openMailbox(mailbox: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.openBox(mailbox, false, (err, box) => {
        if (err) {
          reject(new Error(`Failed to open inbox: ${err.message}`));
          return;
        }
        console.log(`📬 Opened inbox with ${box.messages.total} messages`);
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async fetchMessages(includeRead: boolean = false, limit?: number, mailbox: string = 'INBOX'): Promise<EmailMessage[]> {
    if (!this.connected) {
      throw new Error('IMAP client not connected');
    }

    await this.openMailbox(mailbox);

    return new Promise((resolve, reject) => {
      // Search criteria: unread messages or all messages
      const searchCriteria = includeRead ? ['ALL'] : ['UNSEEN'];
      
      this.imap.search(searchCriteria, (err, results) => {
        if (err) {
          reject(new Error(`Failed to search messages: ${err.message}`));
          return;
        }

        if (!results || results.length === 0) {
          console.log(`📭 No ${includeRead ? '' : 'unread '}messages found`);
          resolve([]);
          return;
        }

        console.log(`📬 Found ${results.length} ${includeRead ? '' : 'unread '}messages`);

        // Apply limit if specified, otherwise use default limits
        let messageIds: number[];
        if (limit) {
          messageIds = results.slice(-limit);
          if (results.length > limit) {
            console.log(`⚠️ Limiting to last ${limit} messages (${results.length - limit} messages will be skipped)`);
          }
        } else if (includeRead) {
          // For first run, get all messages (no limit)
          messageIds = results;
          console.log(`📥 Processing all ${messageIds.length} messages for initial import`);
        } else {
          // For regular runs, limit to last 50 messages
          messageIds = results.slice(-50);
          if (results.length > 50) {
            console.log(`⚠️ Limiting to last 50 unread messages (${results.length - 50} older messages will be skipped)`);
            console.log(`💡 Tip: To process all messages, run with includeRead=true (first run only)`);
          }
        }
        
        const fetch = this.imap.fetch(messageIds, {
          bodies: '',
          struct: true,
          markSeen: false, // Don't mark as read yet
        });

        const messages: EmailMessage[] = [];
        let processedCount = 0;

        fetch.on('message', (msg, seqno) => {
          let buffer = Buffer.alloc(0);
          let uid: number | null = null;

          msg.once('attributes', (attrs: Imap.ImapMessageAttributes) => {
            uid = attrs.uid;
          });

          msg.on('body', (stream) => {
            stream.on('data', (chunk) => {
              buffer = Buffer.concat([buffer, chunk]);
            });
          });

          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(buffer);
              const messageUid = uid ?? seqno;
              if (uid === null) {
                console.warn(`⚠️ UID missing for message ${seqno}, falling back to sequence number`);
              }

              const emailMessage = await this.parseEmailMessage(parsed, messageUid);
              
              // Only include messages that carry an aggregate or forensic DMARC report
              const forensicCount = emailMessage.attachments.filter((a) => a.kind === 'forensic').length;
              const aggregateCount = emailMessage.attachments.length - forensicCount;

              if (this.hasReportAttachment(emailMessage)) {
                messages.push(emailMessage);
                console.log(`  ✅ Message ${messageUid} included (${aggregateCount} aggregate, ${forensicCount} forensic report(s))`);
              } else {
                console.log(`  ⏭️ Message ${messageUid} filtered out (no DMARC report found)`);
                console.log(`     From: ${emailMessage.from}, Subject: ${emailMessage.subject}`);
              }
              
              processedCount++;
              
              if (processedCount === messageIds.length) {
                resolve(messages);
              }
            } catch (error) {
              console.error(`❌ Failed to parse message ${seqno}:`, error);
              processedCount++;
              
              if (processedCount === messageIds.length) {
                resolve(messages);
              }
            }
          });
        });

        fetch.once('error', (err) => {
          reject(new Error(`Failed to fetch messages: ${err.message}`));
        });
      });
    });
  }

  async fetchUnreadMessages(): Promise<EmailMessage[]> {
    return this.fetchMessages(false, 50);
  }

  /**
   * Every message in a mailbox, read-only with respect to the mailbox: no flags are set and
   * nothing is moved. Used to reprocess mail that was already ingested.
   */
  async fetchAllFromMailbox(mailbox: string): Promise<EmailMessage[]> {
    return this.fetchMessages(true, undefined, mailbox);
  }

  private async parseEmailMessage(parsed: ParsedMail, uid: number): Promise<EmailMessage> {
    const attachments: EmailAttachment[] = [];
    const reportedMessages: Buffer[] = [];

    if (parsed.attachments) {
      console.log(`📎 Found ${parsed.attachments.length} attachment(s) in message ${uid}`);
      for (const attachment of parsed.attachments) {
        const filename = attachment.filename || 'unknown';
        const contentType = attachment.contentType || 'unknown';
        let content = attachment.content;

        // A forensic report's failing message. Not a report itself - it is handed to the
        // feedback-report part below, so it must not reach the aggregate XML parser.
        if (contentType.toLowerCase() === 'message/rfc822' && content && content.length > 0) {
          console.log(`  📄 Embedded message (${content.length} bytes) - the mail a forensic report is about`);
          reportedMessages.push(content);
          continue;
        }

        console.log(`  - Attachment: ${filename}, Content-Type: ${contentType}, Size: ${content?.length || 0} bytes`);

        if (this.isForensicAttachment(attachment)) {
          console.log(`  🔎 Recognized as DMARC forensic (RUF) report: ${filename}`);
          attachments.push({
            filename: filename,
            contentType: contentType,
            content: content,
            kind: 'forensic',
          });
          continue;
        }

        if (this.isDmarcAttachment(attachment)) {
          console.log(`  ✅ Recognized as DMARC attachment: ${filename}`);
          
          // Try to decode base64 if content looks like base64 text
          // This is a fallback in case mailparser didn't decode it properly
          if (content && this.looksLikeBase64Text(content)) {
            try {
              const decoded = Buffer.from(content.toString('utf-8').trim(), 'base64');
              if (decoded.length > 0) {
                console.log(`  🔄 Decoded base64 content (${content.length} -> ${decoded.length} bytes)`);
                content = decoded;
              }
            } catch (e) {
              console.warn(`  ⚠️ Failed to decode base64 content: ${e}`);
            }
          }
          
          attachments.push({
            filename: filename,
            contentType: contentType,
            content: content,
            kind: 'aggregate',
          });
        } else {
          console.log(`  ⏭️ Skipped attachment: ${filename} (not recognized as DMARC report)`);
        }
      }
    }

    // Some reporters send no message/feedback-report part at all and put the ARF fields in
    // the message body instead - seen from smaller ISPs.
    const hasForensicPart = attachments.some((a) => a.kind === 'forensic');
    if (!hasForensicPart && RufParser.looksLikeFeedbackReport(parsed.text)) {
      console.log(`  🔎 Found DMARC forensic (RUF) fields in the message body (no feedback-report part)`);
      attachments.push({
        filename: 'feedback-report.txt',
        contentType: 'message/feedback-report',
        content: Buffer.from(parsed.text ?? '', 'utf8'),
        kind: 'forensic',
      });
    }

    if (reportedMessages.length > 0) {
      for (const attachment of attachments) {
        if (attachment.kind === 'forensic' && !attachment.reportedMessage) {
          attachment.reportedMessage = reportedMessages[0];
        }
      }
    }

    return {
      uid,
      subject: parsed.subject || '',
      from: parsed.from?.text || '',
      date: parsed.date || new Date(),
      attachments,
      messageId: parsed.messageId ?? null,
      authenticationResults: this.getHeaderText(parsed, 'authentication-results'),
    };
  }

  /** mailparser hands back a string, an array of strings, or a structured object depending on the header. */
  private getHeaderText(parsed: ParsedMail, name: string): string | null {
    const value = parsed.headers.get(name);
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === 'string');
      return parts.length > 0 ? parts.join('; ') : null;
    }
    return null;
  }

  /** True for the ARF part of a DMARC forensic (RUF) report. */
  private isForensicAttachment(attachment: Attachment): boolean {
    const contentType = (attachment.contentType || '').toLowerCase();
    const filename = (attachment.filename || '').toLowerCase();

    if (!attachment.content || attachment.content.length === 0) {
      return false;
    }

    if (contentType === 'message/feedback-report') {
      return true;
    }

    // Some reporters use a named part instead of the registered content type.
    if (filename.includes('feedback-report')) {
      return true;
    }

    return false;
  }

  private isDmarcAttachment(attachment: Attachment): boolean {
    const filename = attachment.filename?.toLowerCase() || '';
    const contentType = (attachment.contentType || '').toLowerCase();
    let content = attachment.content;
    
    if (!content || content.length === 0) {
      return false;
    }

    const knownExtensions = [
      '.xml',
      '.xml.gz',
      '.xml.zip',
      '.zip',
      '.gz',
      '.gzip',
      '.tgz',
      '.tar.gz',
    ];

    const hasKnownExtension = knownExtensions.some(ext => filename.endsWith(ext));

    // If filename has known extension, accept it
    if (hasKnownExtension) {
      return true;
    }

    // Check content type
    if (
      contentType.includes('xml') ||
      contentType.includes('zip') ||
      contentType.includes('gzip')
    ) {
      return true;
    }

    // Try to decode base64 if content looks like base64 text but filename suggests binary
    // This is a fallback in case mailparser didn't decode it properly
    if (hasKnownExtension && this.looksLikeBase64Text(content)) {
      try {
        const decoded = Buffer.from(content.toString('utf-8').trim(), 'base64');
        if (decoded.length > 0) {
          content = decoded;
        }
      } catch (e) {
        // Decode failed, continue with original content
      }
    }

    // Check content signatures (gzip, zip, xml) - this is the most reliable check
    // This handles cases where filename or content-type might be missing/incorrect
    // but the actual content is clearly DMARC data
    if (this.isZipContent(content) || this.isGzipContent(content)) {
      return true;
    }

    if (this.looksLikeXml(content)) {
      return true;
    }

    // Accept application/octet-stream if filename suggests DMARC
    // This handles cases like: Content-Type: application/octet-stream; Name="report.xml.gz"
    if (contentType.includes('octet-stream') && hasKnownExtension) {
      return true;
    }

    // Check for DMARC-related keywords in filename
    const dmarcKeywords = ['dmarc', 'rua', 'aggregate'];
    if (dmarcKeywords.some(keyword => filename.includes(keyword))) {
      return true;
    }

    return false;
  }

  private looksLikeBase64Text(content: Buffer): boolean {
    if (!content || content.length === 0) {
      return false;
    }
    
    // Check if content looks like base64 text (not binary)
    const text = content.toString('utf-8').trim();
    
    // Base64 strings are alphanumeric with +, /, and = padding
    // They should not contain binary bytes or start with XML/gzip/zip signatures
    if (text.length > 20) {
      const base64Regex = /^[A-Za-z0-9+/=\s\n\r]+$/;
      if (base64Regex.test(text) && 
          !text.trim().startsWith('<') &&
          content[0] !== 0x1f && // Not gzip
          content[0] !== 0x50) {  // Not zip
        return true;
      }
    }
    
    return false;
  }

  private isZipContent(content: Buffer | undefined): boolean {
    if (!content || content.length < 4) {
      return false;
    }

    // ZIP files start with "PK" (0x50 0x4b)
    return content[0] === 0x50 && content[1] === 0x4b;
  }

  private isGzipContent(content: Buffer | undefined): boolean {
    if (!content || content.length < 2) {
      return false;
    }

    // Gzip files start with 0x1f 0x8b
    return content[0] === 0x1f && content[1] === 0x8b;
  }

  private looksLikeXml(content: Buffer | undefined): boolean {
    if (!content || content.length === 0) {
      return false;
    }

    const preview = content.slice(0, 100).toString('utf-8').trimStart();
    return preview.startsWith('<');
  }

  private hasReportAttachment(message: EmailMessage): boolean {
    return message.attachments.length > 0;
  }

  async downloadAttachment(messageUid: number, attachmentFilename: string): Promise<Buffer | null> {
    // This method would be used for more complex attachment handling
    // For now, attachments are already downloaded in fetchUnreadMessages
    const messages = await this.fetchUnreadMessages();
    const message = messages.find(m => m.uid === messageUid);
    
    if (!message) {
      return null;
    }

    const attachment = message.attachments.find(a => a.filename === attachmentFilename);
    return attachment ? attachment.content : null;
  }

  async markAsRead(messageUid: number): Promise<void> {
    if (!this.connected) {
      throw new Error('IMAP client not connected');
    }

    return new Promise((resolve, reject) => {
      this.imap.addFlags(messageUid, ['\\Seen'], (err) => {
        if (err) {
          reject(new Error(`Failed to mark message ${messageUid} as read: ${err.message}`));
          return;
        }
        
        console.log(`✅ Marked message ${messageUid} as read`);
        resolve();
      });
    });
  }

  async markMultipleAsRead(messageUids: number[]): Promise<void> {
    if (!this.connected) {
      throw new Error('IMAP client not connected');
    }

    if (messageUids.length === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.imap.addFlags(messageUids, ['\\Seen'], (err) => {
        if (err) {
          reject(new Error(`Failed to mark messages as read: ${err.message}`));
          return;
        }

        console.log(`✅ Marked ${messageUids.length} messages as read`);
        resolve();
      });
    });
  }

  private mailboxExists(boxes: Imap.MailBoxes, mailboxName: string): boolean {
    return Object.entries(boxes).some(([name, box]) => {
      if (name.toLowerCase() === mailboxName.toLowerCase()) {
        return true;
      }

      if (box.children) {
        return this.mailboxExists(box.children, mailboxName);
      }

      return false;
    });
  }

  private async ensureArchiveMailbox(): Promise<void> {
    if (this.archiveMailboxVerified) {
      return;
    }

    if (!this.connected) {
      throw new Error('IMAP client not connected');
    }

    await new Promise<void>((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
        if (err) {
          reject(new Error(`Failed to retrieve mailboxes: ${err.message}`));
          return;
        }

        if (this.mailboxExists(boxes, this.archiveMailbox)) {
          this.archiveMailboxVerified = true;
          resolve();
          return;
        }

        this.imap.addBox(this.archiveMailbox, addErr => {
          if (addErr) {
            const message = addErr.message || '';
            if (message.toLowerCase().includes('exist')) {
              // Mailbox already exists - treat as success
              this.archiveMailboxVerified = true;
              resolve();
              return;
            }

            reject(new Error(`Failed to create archive mailbox: ${addErr.message}`));
            return;
          }

          console.log(`📁 Created archive mailbox "${this.archiveMailbox}"`);
          this.archiveMailboxVerified = true;
          resolve();
        });
      });
    });
  }

  async moveMessagesToArchive(messageUids: number[]): Promise<void> {
    if (messageUids.length === 0) {
      console.log('📭 No message UIDs provided to archive');
      return;
    }

    if (!this.connected) {
      console.error('❌ Cannot move messages to archive: IMAP client not connected');
      return;
    }

    try {
      await this.ensureArchiveMailbox();
    } catch (error) {
      console.error('❌ Failed to ensure archive mailbox exists:', error);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.imap.move(messageUids, this.archiveMailbox, err => {
        if (err) {
          reject(new Error(`Failed to move messages to ${this.archiveMailbox}: ${err.message}`));
          return;
        }

        console.log(`📁 Moved ${messageUids.length} messages to ${this.archiveMailbox}`);
        resolve();
      });
    }).catch(error => {
      console.error('❌ Failed to move processed messages to archive:', error);
    });
  }

  async processEmails(includeRead: boolean = false): Promise<EmailMessage[]> {
    try {
      console.log('🔄 Starting email processing...');
      
      // Fetch messages with DMARC attachments
      const messages = await this.fetchMessages(includeRead);
      
      if (messages.length === 0) {
        console.log(`📭 No DMARC reports found in ${includeRead ? 'all' : 'unread'} messages`);
        return [];
      }

      console.log(`📬 Found ${messages.length} messages with DMARC attachments`);
      
      // Don't mark as read here - let the EmailProcessor handle it after successful processing
      console.log('✅ Email fetching completed');
      return messages;
      
    } catch (error) {
      console.error('❌ Email processing failed:', error);
      throw error;
    }
  }

  async markProcessedMessagesAsRead(processedMessageUids: number[]): Promise<void> {
    if (processedMessageUids.length === 0) {
      console.log('📭 No message UIDs provided to mark as read');
      return;
    }

    if (!this.connected) {
      console.error('❌ Cannot mark messages as read: IMAP client not connected');
      return;
    }

    console.log(`📧 Marking ${processedMessageUids.length} messages as read: [${processedMessageUids.join(', ')}]`);

    try {
      await this.markMultipleAsRead(processedMessageUids);
      console.log(`✅ Successfully marked ${processedMessageUids.length} messages as read`);
    } catch (error) {
      console.error('❌ Failed to mark processed messages as read:', error);
      // Don't throw here - we don't want to fail the entire process if marking as read fails
    }
  }
}