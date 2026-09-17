/**
 * Development seed. Runs as the owner (DATABASE_URL), which is what lets it
 * insert across every table without tripping row level security.
 *
 *   npm run db:seed
 *
 * Idempotent: safe to run repeatedly.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PrismaClient,
  PricingType,
  ServiceStatus,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';

// The Prisma CLI loads .env for its own commands, but this file is run
// directly by ts-node, which does not. Without this the seed fails with
// "Environment variable not found: DATABASE_URL".
for (const file of ['.env.local', '.env']) {
  const path = resolve(__dirname, '..', file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env before seeding.',
  );
}
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const CATEGORIES = [
  { name: 'Plumbing', slug: 'plumbing', icon: 'droplets' },
  { name: 'Electrical', slug: 'electrical', icon: 'plug-zap' },
  { name: 'Aircon', slug: 'aircon', icon: 'air-vent' },
  { name: 'Computer Repair', slug: 'computer-repair', icon: 'laptop' },
  { name: 'Auto Repair', slug: 'auto-repair', icon: 'car' },
  { name: 'Cleaning', slug: 'cleaning', icon: 'spray-can' },
];

async function main(): Promise<void> {
  const password = await argon2.hash('DevPassword123!', {
    type: argon2.argon2id,
  });

  // -- categories -----------------------------------------------------------
  for (const [i, c] of CATEGORIES.entries()) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: { ...c, position: i },
      update: { name: c.name, icon: c.icon, position: i },
    });
  }
  const aircon = await prisma.category.findUniqueOrThrow({
    where: { slug: 'aircon' },
  });

  // -- admin ----------------------------------------------------------------
  await prisma.user.upsert({
    where: { email: 'admin@fixitph.test' },
    create: {
      email: 'admin@fixitph.test',
      passwordHash: password,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      profile: {
        create: { firstName: 'Ops', lastName: 'Admin', city: 'Butuan City' },
      },
    },
    update: {},
  });

  // -- customer -------------------------------------------------------------
  await prisma.user.upsert({
    where: { email: 'customer@fixitph.test' },
    create: {
      email: 'customer@fixitph.test',
      phone: '+639170000001',
      passwordHash: password,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      profile: {
        create: {
          firstName: 'Ana',
          lastName: 'Reyes',
          city: 'Butuan City',
          barangay: 'Ampayon',
          addressLine1: '12 Narra Street',
          latitude: 8.9475,
          longitude: 125.5406,
        },
      },
    },
    update: {},
  });

  // -- verified provider ----------------------------------------------------
  const providerUser = await prisma.user.upsert({
    where: { email: 'provider@fixitph.test' },
    create: {
      email: 'provider@fixitph.test',
      phone: '+639170000002',
      passwordHash: password,
      role: UserRole.PROVIDER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      profile: {
        create: {
          firstName: 'Rommel',
          lastName: 'Saavedra',
          city: 'Butuan City',
        },
      },
    },
    update: {},
  });

  const provider = await prisma.provider.upsert({
    where: { userId: providerUser.id },
    create: {
      userId: providerUser.id,
      businessName: 'Saavedra Aircon Services',
      slug: 'saavedra-aircon-services',
      headline: 'Aircon cleaning and repair around Butuan',
      baseCity: 'Butuan City',
      baseBarangay: 'Ampayon',
      yearsExperience: 8,
      serviceRadiusKm: 25,
      // Verified, so its listings can go live. verifiedAt is required by the
      // CHECK constraint whenever the status is APPROVED.
      verificationStatus: VerificationStatus.APPROVED,
      verifiedAt: new Date(),
      paymentMethods: ['CASH', 'GCASH'],
    },
    update: {},
  });

  const existingService = await prisma.service.findFirst({
    where: { providerId: provider.id, slug: 'split-type-aircon-cleaning' },
  });

  if (!existingService) {
    await prisma.service.create({
      data: {
        providerId: provider.id,
        categoryId: aircon.id,
        title: 'Split type aircon cleaning',
        slug: 'split-type-aircon-cleaning',
        description:
          'Full cleaning of a split type unit: indoor coil, blower wheel, drain line flush, and outdoor condenser rinse. Bring your own water source if possible.',
        pricingType: PricingType.PER_UNIT,
        price: 450,
        priceUnit: 'unit',
        durationMinutes: 90,
        status: ServiceStatus.ACTIVE,
      },
    });
  }

  console.log('Seed complete.');
  console.log('  admin@fixitph.test    / DevPassword123!');
  console.log('  provider@fixitph.test / DevPassword123!');
  console.log('  customer@fixitph.test / DevPassword123!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
