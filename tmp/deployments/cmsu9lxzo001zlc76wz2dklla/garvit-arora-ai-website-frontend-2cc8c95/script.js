const scrollTrack = (trackName, direction) => {
  const track = document.querySelector(`[data-track="${trackName}"]`);
  if (!track) return;

  const amount = Math.max(260, Math.floor(track.clientWidth * 0.72));
  track.scrollBy({ left: amount * direction, behavior: "smooth" });
};

document.querySelectorAll("[data-slide]").forEach((button) => {
  button.addEventListener("click", () => {
    scrollTrack(button.dataset.slide, Number(button.dataset.direction || 1));
  });
});

document.querySelectorAll(".faq-item").forEach((item) => {
  item.addEventListener("click", () => {
    const wasOpen = item.classList.contains("is-open");
    document.querySelectorAll(".faq-item").forEach((other) => {
      other.classList.remove("is-open");
      const icon = other.querySelector("span");
      if (icon) icon.textContent = "+";
    });

    if (!wasOpen) {
      item.classList.add("is-open");
      const icon = item.querySelector("span");
      if (icon) icon.textContent = "-";
    }
  });
});

const header = document.querySelector(".site-header");

window.addEventListener("scroll", () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 20);
});
