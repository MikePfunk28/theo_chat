const grpc = require('@grpc/grpc-js');
const { V3DataLiveChatMessageServiceClient } = require('./grpc/stream_list_grpc_pb.js');
const { LiveChatMessageListRequest } = require('./grpc/stream_list_pb.js');
const EventEmitter = require('events');
const { getYouTubeApiClient, getGrpcMetadata, getAuthMode } = require('./auth');

// Message type enum from the protobuf
const MessageType = {
  TEXT_MESSAGE_EVENT: 1,
  TOMBSTONE: 2,
  MESSAGE_DELETED_EVENT: 8,
  USER_BANNED_EVENT: 10,
  SUPER_CHAT_EVENT: 15
};

class YouTubeChatService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.liveChatId = null;
    this.videoId = null;
    this.nextPageToken = '';
    this.processedMessageIds = new Set();
    this.activeMessages = new Map(); // messageId -> { userId, displayName }
    this.running = false;
    this.grpcClient = null;
  }

  async start() {
    this.running = true;
    const authMode = getAuthMode(this.config);
    console.log(`  [YT] Starting YouTube chat service (auth: ${authMode})...`);

    try {
      // Get authenticated YouTube API client
      this.youtubeApi = await getYouTubeApiClient(this.config);

      // Find the active live broadcast
      await this.discoverLiveStream();

      if (!this.liveChatId) {
        console.log('  [YT] No active live stream found. Retrying in 30 seconds...');
        if (this.running) {
          setTimeout(() => this.start(), 30000);
        }
        return;
      }

      // Connect via gRPC and start streaming
      await this.connectGrpcStream();

    } catch (err) {
      console.error('  [YT] Error:', err.message);
      this.emit('error', err);
      if (this.running) {
        console.log('  [YT] Reconnecting in 5 seconds...');
        setTimeout(() => this.start(), 5000);
      }
    }
  }

  stop() {
    this.running = false;
    console.log('  [YT] Stopping YouTube chat service.');
  }

  async discoverLiveStream() {
    if (this.config.channelId) {
      console.log(`  [YT] Searching for live streams on channel ${this.config.channelId}...`);
      const response = await this.youtubeApi.search.list({
        channelId: this.config.channelId,
        eventType: 'live',
        type: ['video'],
        part: ['id,snippet']
      });

      if (response.data.items && response.data.items.length > 0) {
        const live = response.data.items[0];
        this.videoId = live.id.videoId;
        console.log(`  [YT] Found live stream: "${live.snippet.title}" (${this.videoId})`);
      } else {
        console.log('  [YT] No active live stream found on this channel.');
        return;
      }
    } else if (this.config.videoId) {
      this.videoId = this.config.videoId;
      console.log(`  [YT] Using configured video ID: ${this.videoId}`);
    } else {
      console.error('  [YT] No channelId or videoId configured.');
      return;
    }

    // Get the live chat ID from the video
    const videoResponse = await this.youtubeApi.videos.list({
      id: [this.videoId],
      part: ['liveStreamingDetails']
    });

    if (videoResponse.data.items && videoResponse.data.items.length > 0) {
      this.liveChatId = videoResponse.data.items[0].liveStreamingDetails?.activeLiveChatId;
      if (this.liveChatId) {
        console.log(`  [YT] Live chat ID: ${this.liveChatId}`);
      } else {
        console.log('  [YT] Video found but no active live chat.');
      }
    }
  }

  async connectGrpcStream() {
    console.log('  [YT] Connecting to YouTube gRPC stream...');

    this.grpcClient = new V3DataLiveChatMessageServiceClient(
      'youtube.googleapis.com:443',
      grpc.credentials.createSsl()
    );

    while (this.running) {
      const metadata = await getGrpcMetadata(this.config);

      const request = new LiveChatMessageListRequest();
      request.setLiveChatId(this.liveChatId);
      request.setMaxResults(200);
      request.setPartList(['snippet', 'authorDetails']);
      if (this.nextPageToken) {
        request.setPageToken(this.nextPageToken);
      }

      const stream = this.grpcClient.streamList(request, metadata);

      try {
        for await (const response of stream) {
          const res = response.toObject();
          this.processResponse(res);
          this.nextPageToken = response.getNextPageToken() || '';
          if (!this.nextPageToken) break;
        }
      } catch (err) {
        if (!this.running) return;

        if (err.code === 0 || err.message.includes('stream ended')) {
          console.log('  [YT] Stream ended, reconnecting...');
        } else {
          console.error(`  [YT] Stream error (code ${err.code}): ${err.message}`);
        }
        break;
      }
    }

    if (this.running) {
      console.log('  [YT] Reconnecting gRPC stream in 2 seconds...');
      await new Promise(r => setTimeout(r, 2000));
      await this.connectGrpcStream();
    }
  }

  processResponse(res) {
    const messages = res.itemsList || [];

    for (const msg of messages) {
      const messageId = msg.id;
      if (!messageId || this.processedMessageIds.has(messageId)) continue;
      this.processedMessageIds.add(messageId);

      const snippet = msg.snippet || {};
      const author = msg.authorDetails || {};
      const type = snippet.type;

      if (type === MessageType.TEXT_MESSAGE_EVENT) {
        const event = {
          type: 'yt.message.created',
          messageId,
          userId: author.channelId || '',
          displayName: author.displayName || 'Unknown',
          profileImageUrl: author.profileImageUrl || '',
          publishedAt: snippet.publishedAt || new Date().toISOString(),
          badges: this.extractBadges(author),
          text: snippet.displayMessage || snippet.textMessageDetails?.messageText || '',
          isSuperChat: false,
          superChatAmount: null,
          raw: msg
        };

        this.activeMessages.set(messageId, {
          userId: event.userId,
          displayName: event.displayName
        });

        this.emit('event', event);

      } else if (type === MessageType.SUPER_CHAT_EVENT) {
        const superChatDetails = snippet.superChatDetails || {};
        const event = {
          type: 'yt.message.created',
          messageId,
          userId: author.channelId || '',
          displayName: author.displayName || 'Unknown',
          profileImageUrl: author.profileImageUrl || '',
          publishedAt: snippet.publishedAt || new Date().toISOString(),
          badges: this.extractBadges(author),
          text: superChatDetails.userComment || snippet.displayMessage || '',
          isSuperChat: true,
          superChatAmount: superChatDetails.amountDisplayString || null,
          raw: msg
        };

        this.activeMessages.set(messageId, {
          userId: event.userId,
          displayName: event.displayName
        });

        this.emit('event', event);

      } else if (type === MessageType.MESSAGE_DELETED_EVENT || type === MessageType.TOMBSTONE) {
        const deletedDetails = snippet.messageDeletedDetails || {};
        const deletedMessageId = deletedDetails.deletedMessageId || '';

        if (deletedMessageId) {
          this.activeMessages.delete(deletedMessageId);

          this.emit('event', {
            type: 'yt.message.deleted',
            messageId: deletedMessageId,
            userId: '',
            displayName: '',
            publishedAt: new Date().toISOString(),
            badges: [],
            text: '',
            isSuperChat: false,
            superChatAmount: null,
            raw: msg
          });
        }

      } else if (type === MessageType.USER_BANNED_EVENT) {
        const bannedDetails = snippet.userBannedDetails || {};
        const bannedUser = bannedDetails.bannedUserDetails || {};
        const bannedUserId = bannedUser.channelId || '';

        const messagesToRemove = [];
        for (const [msgId, info] of this.activeMessages) {
          if (info.userId === bannedUserId) {
            messagesToRemove.push(msgId);
          }
        }
        for (const msgId of messagesToRemove) {
          this.activeMessages.delete(msgId);
        }

        this.emit('event', {
          type: 'yt.user.banned',
          messageId: '',
          userId: bannedUserId,
          displayName: bannedUser.displayName || '',
          publishedAt: new Date().toISOString(),
          badges: [],
          text: '',
          isSuperChat: false,
          superChatAmount: null,
          bannedMessageIds: messagesToRemove,
          banType: bannedDetails.banType || 'unknown',
          raw: msg
        });
      }
    }

    // Prune processedMessageIds to avoid memory growth
    if (this.processedMessageIds.size > 10000) {
      const arr = [...this.processedMessageIds];
      this.processedMessageIds = new Set(arr.slice(arr.length - 5000));
    }
  }

  extractBadges(author) {
    const badges = [];
    if (author.isChatOwner) badges.push('owner');
    if (author.isChatModerator) badges.push('moderator');
    if (author.isChatSponsor) badges.push('member');
    if (author.isVerified) badges.push('verified');
    return badges;
  }
}

module.exports = YouTubeChatService;
