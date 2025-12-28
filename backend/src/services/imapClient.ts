import Imap from 'node-imap';
import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import { config } from '../config/env.js';

export interface EmailMessage {
  uid: number;
  subject: string;
  from: string;
  date: Date;
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export class ImapClient {
  private imap: Imap;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000; // Start with 1 second
  private readonly archiveMailbox = 'dmarc-archive';
  private archiveMailboxVerified = false;

  constructor() {
    this.imap = new Imap({
      user: config.imap.user,
      password: config.imap.password,
      host: config.imap.host,
      port: config.imap.port,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: false,
        servername: config.imap.host, // Explicitly set server name for SNI
        secureProtocol: 'TLSv1_2_method', // Force TLS 1.2
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
    return new Promise((resolve, reject) => {
      this.imap.openBox('INBOX', false, (err, box) => {
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

  async fetchMessages(includeRead: boolean = false, limit?: number): Promise<EmailMessage[]> {
    if (!this.connected) {
      throw new Error('IMAP client not connected');
    }

    await this.openInbox();

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
              
              // Only include messages with DMARC attachments
              if (this.hasDmarcAttachment(emailMessage)) {
                messages.push(emailMessage);
                console.log(`  ✅ Message ${messageUid} included (has ${emailMessage.attachments.length} DMARC attachment(s))`);
              } else {
                console.log(`  ⏭️ Message ${messageUid} filtered out (no DMARC attachments found)`);
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

  private async parseEmailMessage(parsed: ParsedMail, uid: number): Promise<EmailMessage> {
    const attachments: EmailAttachment[] = [];

    if (parsed.attachments) {
      console.log(`📎 Found ${parsed.attachments.length} attachment(s) in message ${uid}`);
      for (const attachment of parsed.attachments) {
        const filename = attachment.filename || 'unknown';
        const contentType = attachment.contentType || 'unknown';
        let content = attachment.content;
        console.log(`  - Attachment: ${filename}, Content-Type: ${contentType}, Size: ${content?.length || 0} bytes`);
        
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
          });
        } else {
          console.log(`  ⏭️ Skipped attachment: ${filename} (not recognized as DMARC report)`);
        }
      }
    }

    return {
      uid,
      subject: parsed.subject || '',
      from: parsed.from?.text || '',
      date: parsed.date || new Date(),
      attachments,
    };
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

  private hasDmarcAttachment(message: EmailMessage): boolean {
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