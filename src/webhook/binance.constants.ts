// Hardcoded tỷ giá USDT → VND. Update tay khi tỷ giá thị trường biến động đáng kể.
// Phải giữ đồng bộ với frontend proxy/src/components/ui/top-up-button.tsx (USDT_VND_RATE).
export const USDT_VND_RATE = 25_500;

// Số USDT tối thiểu cho 1 lần nạp crypto. ~10,000đ tương đương ~0.4 USDT.
export const MIN_DEPOSIT_USDT = 0.4;
