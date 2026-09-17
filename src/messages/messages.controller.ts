import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MESSAGING_THROTTLE } from '../common/throttle';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types';
import { ListMessagesDto, SendMessageDto } from './dto/message.dto';
import { MessagesService } from './messages.service';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** Rate limited: messaging is the other obvious spam surface. */
  @Post()
  @Throttle({ default: MESSAGING_THROTTLE.send })
  send(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendMessageDto) {
    return this.messages.send(user, dto);
  }

  @Get()
  thread(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListMessagesDto,
  ) {
    return this.messages.thread(user, dto);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.unreadCount(user);
  }
}
