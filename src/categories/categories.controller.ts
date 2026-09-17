import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** The whole tree in one call; the frontend nav needs it on every page. */
  @Public()
  @Get()
  tree() {
    return this.categories.tree();
  }

  @Public()
  @Get(':idOrSlug')
  findOne(@Param('idOrSlug') idOrSlug: string) {
    return this.categories.findOne(idOrSlug);
  }
}
