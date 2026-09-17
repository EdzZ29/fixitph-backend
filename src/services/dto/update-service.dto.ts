import { PartialType } from '@nestjs/mapped-types';
import { CreateServiceDto } from './create-service.dto';

/** providerId is never accepted from the client; it comes from the token. */
export class UpdateServiceDto extends PartialType(CreateServiceDto) {}
