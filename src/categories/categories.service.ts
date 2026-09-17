import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/errors';
import { CacheService, TTL } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private get treeKey(): string {
    return this.cache.detailKey('categories', 'tree');
  }

  /** Cached for an hour. The tree changes when an admin edits it, rarely. */
  async tree(): Promise<unknown> {
    return this.cache.wrap(this.treeKey, TTL.CATEGORY_TREE, async () => {
      const rows = await this.prisma.category.findMany({
        where: { isActive: true },
        select: {
          id: true,
          parentId: true,
          name: true,
          slug: true,
          description: true,
          icon: true,
          position: true,
          _count: { select: { services: true } },
        },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      });

      type Node = (typeof rows)[number] & { children: Node[] };
      const byId = new Map<string, Node>(
        rows.map((r) => [r.id, { ...r, children: [] }]),
      );
      const roots: Node[] = [];

      for (const node of byId.values()) {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      return roots;
    });
  }

  async findOne(idOrSlug: string): Promise<unknown> {
    const category = await this.prisma.category.findFirst({
      where: isUuid(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug },
      select: {
        id: true,
        parentId: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        isActive: true,
        children: {
          where: { isActive: true },
          select: { id: true, name: true, slug: true, icon: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!category) throw ApiError.notFound('CATEGORY_NOT_FOUND');
    return category;
  }

  async create(dto: CreateCategoryDto): Promise<unknown> {
    await this.assertParentExists(dto.parentId);
    const category = await this.prisma.category.create({
      data: {
        parentId: dto.parentId ?? null,
        name: dto.name,
        slug: await this.uniqueSlug(dto.name),
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        position: dto.position ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    await this.invalidate();
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<unknown> {
    if (dto.parentId === id) {
      throw ApiError.badRequest(
        'CATEGORY_CYCLE',
        'A category cannot be its own parent.',
      );
    }
    await this.assertParentExists(dto.parentId);
    if (dto.parentId) await this.assertNoCycle(id, dto.parentId);

    const category = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.parentId !== undefined
          ? { parentId: dto.parentId ?? null }
          : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.invalidate();
    return category;
  }

  async remove(id: string): Promise<{ id: string; deactivated: boolean }> {
    const [children, services] = await this.prisma.$transaction([
      this.prisma.category.count({ where: { parentId: id } }),
      this.prisma.service.count({ where: { categoryId: id, deletedAt: null } }),
    ]);

    if (children > 0) {
      throw ApiError.conflict(
        'CATEGORY_HAS_CHILDREN',
        'Move the subcategories first.',
      );
    }

    if (services > 0) {
      // Deactivating keeps existing listings resolvable. A hard delete would
      // orphan them, and the FK is Restrict so it would fail anyway.
      await this.prisma.category.update({
        where: { id },
        data: { isActive: false },
      });
      await this.invalidate();
      return { id, deactivated: true };
    }

    await this.prisma.category.delete({ where: { id } });
    await this.invalidate();
    return { id, deactivated: false };
  }

  /**
   * Any category mutation drops the tree and every cached listing, because a
   * renamed or hidden category changes what those responses should contain.
   */
  private async invalidate(): Promise<void> {
    await this.cache.invalidateDetail('categories', 'tree');
    await this.cache.invalidateLists('categories');
    await this.cache.invalidateLists('services');
    await this.cache.invalidateLists('providers');
  }

  private async assertParentExists(parentId?: string): Promise<void> {
    if (!parentId) return;
    const parent = await this.prisma.category.findUnique({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) {
      throw ApiError.badRequest(
        'PARENT_NOT_FOUND',
        'That parent category is unknown.',
      );
    }
  }

  /** Walks up from the proposed parent to confirm it is not a descendant. */
  private async assertNoCycle(id: string, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor && depth < 20; depth++) {
      if (cursor === id) {
        throw ApiError.badRequest(
          'CATEGORY_CYCLE',
          'That would create a loop in the tree.',
        );
      }
      const row: { parentId: string | null } | null =
        await this.prisma.category.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = row ? row.parentId : null;
    }
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'category';
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const clash = await this.prisma.category.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 110);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
