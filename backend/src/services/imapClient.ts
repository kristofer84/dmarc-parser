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

      this.imap.once('end', () => {
        resolve();
      });

      this.imap.end();
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
        } else if (includeRead) {
          // For first run, get all messages (no limit)
          messageIds = results;
          console.log(`📥 Processing all ${messageIds.length} messages for initial import`);
        } else {
          // For regular runs, limit to last 50 messages
          messageIds = results.slice(-50);
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

          msg.on('body', (stream) => {
            stream.on('data', (chunk) => {
              buffer = Buffer.concat([buffer, chunk]);
            });
          });

          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(buffer);
              const emailMessage = await this.parseEmailMessage(parsed, seqno);
              
              // Only include messages with DMARC attachments
              if (this.hasDmarcAttachment(emailMessage)) {
                messages.push(emailMessage);
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
      for (const attachment of parsed.attachments) {
        if (this.isDmarcAttachment(attachment)) {
          attachments.push({
            filename: attachment.filename || 'unknown',
            contentType: attachment.contentType,
            content: attachment.content,
          });
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
    const contentType = attachment.contentType.toLowerCase();
    
    // Check for DMARC report indicators
    return (
      filename.includes('dmarc') ||
      contentType.includes('xml') ||
      contentType.includes('zip') ||
      contentType.includes('gzip')
    );
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