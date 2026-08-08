import { getCart, addToCart, updateCart, removeFromCart } from "@/features/cart/cart.api";

export const GET = getCart;
export const POST = addToCart;
export const PATCH = updateCart;
export const DELETE = removeFromCart;
