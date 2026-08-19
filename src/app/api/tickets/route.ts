import { createTicketHandler, listMyTicketsHandler } from "@/features/service/service.api";

export const POST = createTicketHandler;
export const GET = listMyTicketsHandler;
