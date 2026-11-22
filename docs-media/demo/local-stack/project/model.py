"""The denoiser's architecture (simulated): what a commit changes"""
ARCH = {
  "name": "unet-s",
  "channels": [32, 64, 128],
  "attention_skips": False,
}
# how good this architecture gets, fully trained (0..1), and how sure its detection head is
CAPACITY = 0.84
CONFIDENCE = 0.0
