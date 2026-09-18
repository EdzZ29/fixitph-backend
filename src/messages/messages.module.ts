import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  // One direction only: messages need storage to sign and store attachments,
  // storage knows nothing about messages.
  imports: [UploadsModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
