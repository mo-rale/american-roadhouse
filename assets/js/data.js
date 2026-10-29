/**
 * CENTRALIZED CONTENT DATA
 * ------------------------------------------------------------------
 * Everything a client or developer needs to update - room details,
 * menu items, gallery photos, reviews and FAQs - lives in this one
 * file. No content is hardcoded inside the HTML pages themselves;
 * each page reads from these arrays and renders them at runtime.
 *
 * All values below are clearly-labelled PLACEHOLDERS until the real
 * business confirms room names, prices, amenities, and photography.
 * Replace the "img" label strings with real photo paths (e.g.
 * "assets/img/rooms/deluxe-01.jpg") once photography is available.
 * ------------------------------------------------------------------
 */

const ROOMS = [
  {
    id: "room-1",
    name: "Room Name",
    img: "Room photo placeholder",
    category: "Rooms",
    capacity: "2 Guests",
    amenities: ["Private bathroom", "Air conditioning", "Free Wi-Fi"],
    description: "Comfortable accommodation designed for a relaxing stay in Tugas, Candijay.",
    price: "Contact for availability",
  },
  {
    id: "room-2",
    name: "Room Name",
    img: "Room photo placeholder",
    category: "Rooms",
    capacity: "2–3 Guests",
    amenities: ["Private bathroom", "Air conditioning", "Free Wi-Fi"],
    description: "A quiet, comfortable room suited for couples or small groups.",
    price: "Contact for availability",
  },
  {
    id: "room-3",
    name: "Room Name",
    img: "Room photo placeholder",
    category: "Rooms",
    capacity: "3–4 Guests",
    amenities: ["Private bathroom", "Air conditioning", "Free Wi-Fi"],
    description: "Extra space for families and small groups travelling together.",
    price: "Contact for availability",
  },
  {
    id: "room-4",
    name: "Room Name",
    img: "Room photo placeholder",
    category: "Rooms",
    capacity: "2 Guests",
    amenities: ["Private bathroom", "Air conditioning", "Free Wi-Fi"],
    description: "A cozy option for solo travelers or couples passing through Bohol.",
    price: "Contact for availability",
  },
];

const MENU_CATEGORIES = ["Breakfast", "Main Dishes", "Snacks", "Drinks"];

const MENU_ITEMS = [
  { id: "m1", category: "Breakfast", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this breakfast dish.", price: "Ask for today's price" },
  { id: "m2", category: "Breakfast", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this breakfast dish.", price: "Ask for today's price" },
  { id: "m3", category: "Main Dishes", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this main dish.", price: "Ask for today's price" },
  { id: "m4", category: "Main Dishes", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this main dish.", price: "Ask for today's price" },
  { id: "m5", category: "Main Dishes", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this main dish.", price: "Ask for today's price" },
  { id: "m6", category: "Snacks", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this snack item.", price: "Ask for today's price" },
  { id: "m7", category: "Snacks", name: "Dish Name", img: "Food photo placeholder", description: "Short description of this snack item.", price: "Ask for today's price" },
  { id: "m8", category: "Drinks", name: "Drink Name", img: "Drink photo placeholder", description: "Short description of this drink.", price: "Ask for today's price" },
];

const GALLERY_IMAGES = [
  { id: "g1", category: "Hotel", label: "Hotel photo placeholder", span: "span-2-2" },
  { id: "g2", category: "Rooms", label: "Room photo placeholder", span: "" },
  { id: "g3", category: "Restaurant", label: "Restaurant photo placeholder", span: "" },
  { id: "g4", category: "Food", label: "Food photo placeholder", span: "span-1-2" },
  { id: "g5", category: "Exterior", label: "Exterior photo placeholder", span: "" },
  { id: "g6", category: "Hotel", label: "Hotel photo placeholder", span: "" },
  { id: "g7", category: "Food", label: "Food photo placeholder", span: "span-2-1" },
  { id: "g8", category: "Rooms", label: "Room photo placeholder", span: "" },
  { id: "g9", category: "Restaurant", label: "Restaurant photo placeholder", span: "" },
  { id: "g10", category: "Exterior", label: "Exterior photo placeholder", span: "span-1-2" },
  { id: "g11", category: "Hotel", label: "Hotel photo placeholder", span: "" },
  { id: "g12", category: "Food", label: "Food photo placeholder", span: "" },
];


const FAQS = [
  {
    q: "What room options are available?",
    a: "Placeholder answer - to be confirmed with current room inventory. Please contact us directly for up-to-date room options and availability.",
  },
  {
    q: "How can I make a reservation?",
    a: "You can send a booking request through our online form, or call us directly at 0915 875 4860. Our team will confirm availability with you.",
  },
  {
    q: "What are the check-in and check-out times?",
    a: "Placeholder answer - check-in and check-out times will be confirmed here once finalized. Please call ahead to confirm current times.",
  },
  {
    q: "Does the restaurant accept walk-ins?",
    a: "Placeholder answer - please contact us to confirm current walk-in policy and hours.",
  },
  {
    q: "Where is American Roadhouse located?",
    a: "American Roadhouse Hotel and Restaurant is located at Purok 5 Tugas, Candijay, Bohol 6312, Philippines.",
  },
  {
    q: "How can I contact the hotel?",
    a: "You can reach us by phone at 0915 875 4860, or send a message through our contact form and our team will get back to you.",
  },
];
