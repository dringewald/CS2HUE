document.addEventListener("DOMContentLoaded", () => {
    const scrollBtn = document.getElementById("scrollToTopBtn");

    if (!scrollBtn) return;

    // Show/hide button based on scroll position
    window.addEventListener("scroll", () => {
        const scrollY = window.scrollY;
        const bottomThreshold = document.body.scrollHeight - window.innerHeight - 100;

        if (scrollY > 300 && scrollY < bottomThreshold) {
            scrollBtn.classList.remove("hidden");
        } else {
            scrollBtn.classList.add("hidden");
        }
    });

    // Scroll to top when button is clicked
    scrollBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
});