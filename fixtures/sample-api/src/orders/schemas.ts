import { z } from 'zod';
import { pageOf } from '../pagination.js';

export const Currency = z.enum(['USD', 'EUR', 'GBP']);
export const OrderStatus = z.enum(['pending', 'paid', 'cancelled']);

const AmountCents = z.number().int().min(1).max(100_000_000);

export const Order = z.object({
  id: z.uuid(),
  customerEmail: z.email(),
  amountCents: AmountCents,
  currency: Currency,
  status: OrderStatus,
  createdAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

export const OrderPage = pageOf(Order);

export const OrderIdParams = z.object({ id: z.uuid() });

export const CreateOrderBody = z.strictObject({
  customerEmail: z.email(),
  amountCents: AmountCents,
  currency: Currency,
});
export type CreateOrderBody = z.infer<typeof CreateOrderBody>;

export const UpdateOrderBody = z
  .strictObject({
    amountCents: AmountCents.optional(),
    status: OrderStatus.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });
export type UpdateOrderBody = z.infer<typeof UpdateOrderBody>;
