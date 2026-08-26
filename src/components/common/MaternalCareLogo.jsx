import "../../styles/maternal-care-logo.css";

export const maternalCareLogo = "/images/maternal-care-logo.png";

export default function MaternalCareLogo({
  className = "",
  decorative = false,
  variant = "default",
}) {
  const classes = [
    "maternal-care-logo",
    `maternal-care-logo--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <img
      className={classes}
      src={maternalCareLogo}
      alt={decorative ? "" : "Maternal Care"}
      aria-hidden={decorative ? "true" : undefined}
      decoding="async"
      draggable="false"
    />
  );
}
