import { SetMetadata } from '@nestjs/common';

export const ROUTE_ID = 'tr:route-id';
export const PUBLIC_ROUTE = 'tr:public';

/**
 * Binds a handler to its contract in packages/contracts (permission, rate class, body schema).
 * A handler without @Route or @Public is refused by the guard (fails closed, ADD L7).
 */
export const Route = (id: string) => SetMetadata(ROUTE_ID, id);
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
