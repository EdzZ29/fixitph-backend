import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { MESSAGING_THROTTLE, WRITE_THROTTLE } from '../common/throttle';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types';
import { ListMessagesDto, SendMessageDto } from './dto/message.dto';
import { SendAttachmentDto } from './dto/send-attachment.dto';
import {
  UploadsService,
  type UploadedFile as MulterFile,
} from '../uploads/uploads.service';
import { IMAGE_MIMES } from '../uploads/file-type';
import { MessagesService } from './messages.service';

/**
 * Sending a photo is sending a message, so it lives here.
 *
 * It was briefly on /uploads with the other multipart routes, which put
 * UploadsModule and MessagesModule in a cycle — the uploads controller needed
 * MessagesService to create the message, while MessagesService needed
 * UploadsService to sign the links. Keeping the route on this side leaves the
 * dependency pointing one way, and the URL describes what is happening better
 * than "upload" did.
 */
@Controller('messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly uploads: UploadsService,
  ) {}

  /** Rate limited: messaging is the other obvious spam surface. */
  @Post()
  @Throttle({ default: MESSAGING_THROTTLE.send })
  send(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendMessageDto) {
    return this.messages.send(user, dto);
  }

  /**
   * A photo, and the message carrying it, in one request.
   *
   * Images only, decided by sniffing the bytes rather than trusting the
   * declared type — a thread is for "here is the pipe", and accepting
   * arbitrary files would make it a way to hand somebody an executable.
   */
  @Post('attachment')
  @Throttle({ default: WRITE_THROTTLE.serviceImage })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  async sendAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: MulterFile,
    @Body() dto: SendAttachmentDto,
  ) {
    /**
     * Stored before the message exists, so a rejected file never leaves an
     * empty bubble in somebody's thread. If the thread then turns out not to
     * be theirs, the object is removed rather than left orphaned.
     */
    const stored = await this.uploads.store(
      file,
      `message-attachments/${user.id}`,
      IMAGE_MIMES,
    );

    try {
      return await this.messages.sendImage(
        user,
        { bookingId: dto.bookingId, serviceRequestId: dto.serviceRequestId },
        dto.body,
        stored,
      );
    } catch (thrown) {
      await this.uploads.remove(stored.storageKey).catch(() => undefined);
      throw thrown;
    }
  }

  @Get()
  thread(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListMessagesDto,
  ) {
    return this.messages.thread(user, dto);
  }

  /**
   * Declared before the bare @Get so it is not read as a thread query with
   * no anchor, which would be a 400.
   */
  @Get('threads')
  threads(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.listThreads(user);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.unreadCount(user);
  }
}
