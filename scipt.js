// Example of a simple animation or dynamic behavior
document.addEventListener("DOMContentLoaded", () => {
  const prices = document.querySelectorAll(".price");
  prices.forEach(price => {
    price.addEventListener("mouseover", () => {
      price.style.color = "#a855f7";
    });
    price.addEventListener("mouseout", () => {
      price.style.color = "#ff5e5e";
    });
  });

  // Optional: Highlight active bottom nav when clicked
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      navItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
    });
  });
});
