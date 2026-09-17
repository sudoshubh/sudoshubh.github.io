# Computer Vision Q&A Study Guide

## Table of Contents
1. [Image Fundamentals](#image-fundamentals)
2. [Compression](#compression)
3. [Motion and Optical Flow](#motion-and-optical-flow)
4. [Object Detection](#object-detection)
5. [Segmentation](#segmentation)
6. [Deep Learning Architectures](#deep-learning-architectures)
7. [Evaluation Metrics](#evaluation-metrics)
8. [Domain and Robustness](#domain-and-robustness)

---

## Image Fundamentals

### Contrast and Intensity Distribution

**Q: Two grayscale images have the same average intensity, but Image A has most pixels between 110–140 while Image B contains values spread from 20–230. Which image is likely to have higher contrast?**

**A:** Image B has higher contrast because its intensities span a much wider range (20–230 vs 110–140).

**Explanation:** Contrast measures intensity spread, not mean. Standard contrast is quantified by standard deviation of pixel intensities, which is independent of mean. Image A's narrow band produces flat, low-contrast appearance; Image B's wide spread creates strong differences between dark and bright regions.

---

**Q: Explain why average brightness alone cannot answer this question. (one sentence)**

**A:** Average brightness only tells you the mean, not how those values are distributed—contrast requires knowing the *spread* of intensities around that mean.

---

### Histograms

**Q: A photograph has almost all its histogram values concentrated near the dark end. Which interpretation is most defensible?**

Options:
- The image must contain one large dark object located at its centre.
- The image is likely dominated by low-intensity pixels, but the histogram alone does not reveal their spatial arrangement.
- The image must have high contrast because most values are near zero.
- The histogram uniquely determines the semantic content and locations of objects.

**A:** Option 2 is correct.

**What the histogram tells us:**
- The image is predominantly dark (most pixels have low values)
- Overall tone is dim
- Limited use of bright regions

**What the histogram cannot tell us:**
- **Spatial arrangement** — where those dark pixels are located
- **Object structure** — what causes the darkness (single object vs. many)
- **Semantic content** — what the image depicts
- **Contrast quality** — actually indicates *low* contrast if all values cluster near dark
- **Image purpose** — night photo, silhouette, underexposure, artistic choice

Histograms are 1D summaries that discard all positional information.

---

## Compression

### Log Transformations

**Q: An astronomical image contains a few extremely bright stars but many weak structures in dark regions. Why is a log transformation a particularly suitable choice?**

Options:
- It applies the same multiplicative gain to every intensity and therefore preserves all relative spacing.
- It expands differences among low intensities while compressing large values, making dark detail more visible without letting bright values dominate.
- It expands high intensities more than low intensities, making bright stars dominate further.
- It removes impulse noise by replacing each pixel with a neighbourhood median.

**A:** Option 2 is correct.

**Why log beats constant multiplication:**

Constant multiplier (linear):
- Weak dark pixel: 5 → 5 × 5 = 25
- Bright star: 10,000 → 10,000 × 5 = 50,000
- Ratio preserved: 10,000/5 = 2,000 remains huge
- Cannot display both without saturation

Log transformation (nonlinear):
- Weak dark pixel: log(5) ≈ 0.7
- Bright star: log(10,000) ≈ 4.0
- Ratio compressed: 4.0/0.7 ≈ 5.7 (much smaller)
- Both details fit within displayable range
- Reveals detail across orders of magnitude

**Key:** Log compresses dynamic range; constant multiplication only rescales.

---

### JPEG Compression Pipeline

**Q: A JPEG-like compression system performs: RGB → YCbCr → chroma downsampling → DCT → quantization → encoding. Which statement best describes the roles of these stages?**

Options:
- YCbCr removes all color; DCT detects objects; encoding is the main irreversible operation.
- Chroma downsampling increases color resolution; DCT works only in the spatial domain; quantization is lossless.
- YCbCr separates luminance/chrominance, chroma downsampling reduces color detail, DCT maps blocks to frequency coefficients, and quantization is the principal irreversible stage.
- Quantization reconstructs discarded frequencies exactly, while entropy encoding intentionally removes high-frequency image content.

**A:** Option 3 is correct.

**Purpose of three key stages:**

1. **YCbCr transformation**
   - Separates brightness (Y) from color (Cb, Cr)
   - Exploits human perception: we're far more sensitive to luminance than color
   - Enables different compression strategies for each component

2. **Chroma downsampling**
   - Reduces spatial resolution of color channels (e.g., 4:2:0)
   - Discards imperceptible color detail
   - Achieves significant compression before mathematical transform

3. **DCT (Discrete Cosine Transform)**
   - Converts 8×8 pixel blocks from spatial to frequency domain
   - Energy concentrates in low frequencies for natural images
   - Enables quantization to target perceptually irrelevant high-frequency noise

**Irreversible stage: Quantization**

Quantization divides coefficients by step sizes and **rounds**, permanently discarding information. All other stages are theoretically reversible; only quantization causes irreversible data loss.

---

## Motion and Optical Flow

### B-frames and Latency Trade-off

**Q: A video engineer suggests using as many B-frames as possible because compression improves. Another engineer objects because the application is live teleoperation of a robot. Which statement best captures the disagreement?**

Options:
- B-frames cannot use temporal information, so they always increase bitrate without affecting delay.
- B-frames are ideal for teleoperation because they require no reference frames and therefore minimize latency.
- The dispute is only about image brightness and has no relation to decoding dependencies.
- B-frames can improve compression by using temporal prediction, but dependence on surrounding frames can increase latency and memory; the trade-off is compression efficiency versus real-time responsiveness.

**A:** Option 4 is correct.

**The core disagreement:**

| Engineer 1 | Engineer 2 |
|-----------|-----------|
| Maximizes compression ratio | Prioritizes low latency |
| Valid for file storage/streaming with buffering | Valid for live control systems |

**Why B-frames are problematic for teleoperation:**
- B-frames use bidirectional prediction (past + future frames)
- Decoder must wait for future frames before decoding → increased end-to-end delay
- Robot control cannot tolerate frame delays; response lag makes manipulation dangerous

**Better choice for teleoperation:** I-frames (no dependencies) or P-frames (past-only prediction)

---

**Q: Explain both viewpoints and identify the central trade-off. (short)**

**A:**

**Engineer 1 (compression focus):** B-frames use bidirectional prediction (past + future frames), achieving high compression ratios. Valid for recorded/stored video where buffering is acceptable.

**Engineer 2 (teleoperation focus):** B-frames require future frame buffering before decoding, adding latency. Live robot control cannot tolerate frame delay—operator feedback must be immediate for safe, responsive manipulation.

**Central trade-off:** Compression efficiency vs. real-time latency. More compression (B-frames) demands more buffering, which kills responsiveness.

---

### Optical Flow

**Q: At one image location, the optical-flow vector is (u,v)=(-5,12). Which result is correct?**

Options:
- Magnitude = 7; horizontal and vertical components are both positive.
- Magnitude = 13; the horizontal component is negative and the vertical component is positive.
- Magnitude = 17; the motion has only a horizontal component.
- Magnitude = 60; direction cannot be inferred from the signs of u and v.

**A:** Option 2 is correct.

**Calculation:**
```
Magnitude = √(u² + v²) = √((-5)² + 12²) = √(25 + 144) = √169 = 13
```

**Interpretation:**
- u = -5 (negative) → leftward motion
- v = 12 (positive) → downward motion
- Pixel moved left and down by 13 pixels total

---

**Q: Calculate the flow magnitude and describe the approximate direction of motion. (1 mark answer)**

**A:**

**Magnitude:** √((-5)² + 12²) = √169 = **13 pixels**

**Direction:** Negative u (−5) indicates leftward motion; positive v (+12) indicates downward motion. The pixel moved **left and down** (southwest/bottom-left direction).

---

### Optical Flow and HOF (Histogram of Optical Flow)

**Q: A surveillance camera slowly pans right while all people in the scene are stationary. Which description best characterizes the optical-flow/HOF behaviour?**

Options:
- There should be no optical flow because the people are physically stationary.
- Only object colors change; optical flow is unaffected by camera movement.
- HOF automatically separates camera-induced and person-induced motion before building its histogram.
- A broad, coherent flow pattern can appear across the frame due to camera motion, and HOF may interpret that image motion as action-related motion.

**A:** Option 4 is correct.

**What happens:** When the camera pans right, the entire scene (including stationary people) appears to shift left—this is **egomotion**.

**Optical flow captures this:** Every pixel has a leftward flow vector due to the pan, creating a strong, coherent flow field.

**HOF problem:** The histogram includes camera-induced motion. Standard HOF cannot distinguish between:
- A person actually walking left
- A stationary person appearing to move left due to camera pan

Both produce leftward flow vectors that add to the HOF, potentially triggering false activity detection.

---

**Q: What would optical flow look like? Why might this confuse an action representation based primarily on HOF? (short)**

**A:**

**Optical flow:** A coherent, uniform leftward flow field across the entire frame—all pixels shift left uniformly due to the rightward camera pan, regardless of people being stationary.

**HOF confusion:** HOF only sees motion vectors without spatial context or camera information. It treats camera-induced leftward flow the same as person-induced leftward flow, potentially triggering false activity detection or masking genuine actions. **No separation of egomotion from actor motion.**

---

### Motion Boundary Histogram (MBH)

**Q: Two athletes both move from left to right at approximately the same average speed. One is cycling; the other is running. Which statement best explains the expected descriptor behaviour?**

Options:
- Their HOF can be similar because dominant flow direction is similar, while MBH can differ because limb/articulation patterns create different local flow gradients.
- Their HOG must be identical because both move in the same direction.
- MBH ignores local changes in motion and therefore should be more similar than HOF.
- HOF explicitly encodes object identity, so cycling and running must have unrelated HOF histograms.

**A:** Option 1 is correct.

**HOF (Histogram of Optical Flow):**
- Both athletes move left → right at similar speed
- Both produce dominant rightward flow vectors with similar magnitude
- Global motion pattern nearly identical
- → HOF histograms are **similar**

**MBH (Motion Boundary Histogram):**
- Captures *spatial gradients* (changes) in optical flow, not absolute motion
- Cyclist: legs pedal in circles, localized lower-body motion; upper body stable
- Runner: legs move linearly in alternating pattern; arms swing; full-body articulation
- Different patterns of flow changes at different locations
- → MBH histograms are **different**

---

**Q: Why might their HOF descriptors be more similar than their MBH descriptors? (1 mark)**

**A:**

**HOF captures global motion:** Both athletes move right at similar speed, producing dominant rightward flow vectors → similar HOF histograms.

**MBH captures local flow gradients:** Cycling has circular leg motion (localized); running has alternating linear leg motion with arm swings (full-body articulation). These create different spatial patterns of flow *changes* → different MBH histograms.

**Global motion is similar; articulation patterns differ.**

---

## Object Detection

### BoVW (Bag of Visual Words)

**Q: Consider: interest points → HOG/HOF/MBH → BoVW → SVM. Which statement gives a fair strength-and-limitations summary of the BoVW representation?**

Options:
- It provides a fixed-length summary of local descriptors, but the histogram discards much of their spatial/temporal arrangement and depends on a handcrafted codebook/descriptor pipeline.
- It preserves the exact order and geometry of every local descriptor, so it has no representation loss.
- It removes the need to choose descriptors because BoVW directly operates on raw video frames.
- It is fully end-to-end differentiable and therefore learns motion features jointly with the SVM.

**A:** Option 1 is correct.

**Strengths:**
- Fixed-length representation regardless of video length
- Compact summary suitable for SVM training

**Limitations:**
- **Spatial/temporal loss** — "bag of words" discards *where* and *when* features occurred
- **No geometry** — two different motion sequences can produce identical BoVW if they contain the same visual words
- **Handcrafted pipeline** — depends on pre-computed codebook and manually engineered descriptors (HOG/HOF/MBH)
- **Not end-to-end learnable** — features fixed before SVM training

---

**Q: Explain one strength and two limitations of representing a video using a Bag-of-Visual-Words histogram for action recognition. (1 mark)**

**A:**

**Strength:** Produces a fixed-length histogram from variable-length videos, enabling standard classifiers like SVM.

**Limitation 1:** Discards spatial and temporal order—two videos with identical visual words but different motion sequences get identical histograms.

**Limitation 2:** Depends on handcrafted descriptors (HOG/HOF/MBH) and a fixed codebook built before training; features cannot be learned end-to-end.

---

### Classification vs Detection

**Q: An image classifier says: "There is a dog in this image." What essential information is still missing for object detection?**

Options:
- The location of each object (e.g., bounding box), along with per-object class/confidence predictions.
- Only the average image brightness.
- A frequency-domain representation of the image.
- The color model used by the camera.

**A:** Option 1 is correct.

**Image Classification:** Answers "What is in this image?" → Output: Class label (e.g., "dog")

**Object Detection:** Answers "What is in this image **and where**?" → Output: Class label + bounding box + confidence score

**Missing information:** Bounding box coordinates, per-object predictions, confidence scores.

---

**Q: Why is this insufficient for object detection? What additional information must a detector provide? (1 mark)**

**A:**

**Why insufficient:** Classification only answers "what is in the image?" but not "where is it?" — no spatial localization.

**Additional information needed:** Bounding box coordinates (x, y, width, height) for each object instance, along with per-object class labels and confidence scores.

---

### Sliding-Window Detection

**Q: A detector tries windows at hundreds of spatial locations, 8 scales, and 5 aspect ratios. Why does exhaustive sliding-window detection become computationally expensive?**

Options:
- Only one window can be evaluated per image regardless of the chosen grid.
- Changing aspect ratio eliminates the need to evaluate spatial locations.
- Window enumeration becomes cheaper as more scales are added.
- The candidate count grows multiplicatively across locations, scales, and aspect ratios, producing a very large number of windows to evaluate.

**A:** Option 4 is correct.

**The exponential burden:**
```
Total windows = locations × scales × aspect ratios
             = hundreds × 8 × 5 = thousands of windows per image
```

**Cost per window:** Extract features (HOG/CNN), run classifier, compute NMS.

**Result:** Thousands of redundant feature extractions for every image. Modern detectors address this via region proposals (Faster R-CNN) or anchor-based detection (YOLO, SSD).

---

**Q: Explain why exhaustive sliding-window detection becomes computationally expensive even before using a deep classifier. (1 mark)**

**A:**

**Multiplicative window growth:** locations × scales × aspect ratios = hundreds × 8 × 5 = thousands of candidate windows per image.

**Feature extraction cost:** Each window requires expensive feature computation (HOG, CNN backbone) — even before running the classifier. Extracting features for thousands of redundant, overlapping windows is inherently wasteful.

---

### Anchor Shapes

**Q: A dataset contains pedestrians, buses, and traffic signs. Why would using only square anchors be a poor design?**

Options:
- Objects have different scales and aspect ratios; multiple anchor shapes provide better starting matches for tall, wide, and compact objects.
- Anchor boxes are used only after NMS, so their shape never affects matching.
- Square anchors prevent classification loss from being computed.
- Object detectors require one anchor shape for each semantic class and cannot share anchors.

**A:** Option 1 is correct.

**Why square anchors fail:**
- **Pedestrians:** tall and narrow (high aspect ratio) → wasted space in square anchor
- **Buses:** long and wide (low aspect ratio) → poor fit
- **Traffic signs:** roughly square → reasonable but suboptimal

**Better design:** Multiple anchor shapes (1:1, 2:1, 1:2, 4:1) at multiple scales. Each object type finds a close-matching anchor template, reducing regression burden and improving accuracy.

---

**Q: Relate your answer to scale and aspect ratio. (1 mark)**

**A:**

**Square anchors have fixed 1:1 aspect ratio:** They match only compact objects well.

**Objects vary in aspect ratio:** Pedestrians are tall/narrow (high aspect ratio); buses are wide/short (low aspect ratio). Forcing both into square anchors creates poor initial alignment.

**Multiple anchor shapes (e.g., 1:1, 2:1, 1:2, 4:1) at multiple scales:** Each object type finds a close-matching anchor as a starting template, reducing regression burden and improving detection accuracy.

---

### Bounding Box Regression

**Q: An anchor overlaps a car but is shifted left and is too narrow. What should bounding-box regression learn?**

Options:
- Only a new class label; box geometry should remain unchanged.
- A horizontal position correction and an increase in width (plus any other required box-coordinate refinements).
- Only the NMS threshold for the image.
- A new image histogram that makes the car brighter.

**A:** Option 2 is correct.

**Bounding-box regression task:** Learn to predict offsets to anchor coordinates:
- **Δx (horizontal shift):** Move anchor right
- **Δw (width adjustment):** Increase width
- **Δy, Δh (optional):** Vertical position and height if needed

**Output:** Refined bounding box = anchor + predicted offsets

---

**Q: What should bounding-box regression learn to change? Do not just state "correct the box"; describe the types of correction. (1 mark)**

**A:**

**Bounding-box regression learns four types of coordinate offsets:**

1. **Δx:** Horizontal position shift → move anchor rightward to align the car center
2. **Δy:** Vertical position shift → adjust vertical alignment if needed
3. **Δw:** Width adjustment → increase width to match car extent
4. **Δh:** Height adjustment → adjust height if needed

**Output:** Refined box = anchor coordinates + predicted offsets.

---

### IoU and Target Assignment

**Q: For one object: IoU(A)=0.79, IoU(B)=0.46, IoU(C)=0.03. Without assuming an exact training threshold, which interpretation is most appropriate?**

Options:
- A is a strong positive candidate, C is clearly background, and B is intermediate/threshold-dependent.
- C is the strongest positive because low IoU means tighter localization.
- All three anchors must be positive because they refer to the same image.
- IoU cannot be used to reason about anchor-to-ground-truth assignment.

**A:** Option 1 is correct.

**Interpretation:**
- **A (IoU = 0.79):** Strong positive → well-aligned with object
- **C (IoU = 0.03):** Clear negative/background → barely overlaps
- **B (IoU = 0.46):** Ambiguous → depends on training threshold

---

**Q: Without assuming an exact training threshold, explain how you would conceptually interpret these three anchors during target assignment. (short)**

**A:**

**A (IoU = 0.79):** Strong positive — anchor is well-aligned with the object; should be trained as an object match regardless of threshold choice.

**C (IoU = 0.03):** Clear negative/background — anchor barely overlaps; should always be treated as non-object.

**B (IoU = 0.46):** Ambiguous/threshold-dependent — overlaps moderately but too misaligned for confident positive. Its assignment depends on the chosen IoU threshold during training.

**Conceptual principle:** Higher IoU = better anchor-to-object alignment → stronger candidate for positive assignment.

---

### Class Imbalance and Focal Loss

**Q: A dense detector generates 50 positive anchors and 50,000 easy background anchors. Which training modification most directly addresses the resulting imbalance?**

Options:
- ROIAlign, because it removes all background anchors before training.
- A lower NMS threshold during training, because NMS changes class-loss weights.
- Focal loss, because it downweights easy well-classified examples so they do not dominate the loss.
- Histogram equalization, because it balances positive and negative anchors.

**A:** Option 3 is correct.

**Why the imbalance is problematic:**

With 50 positives and 50,000 background anchors, standard cross-entropy loss is dominated by accumulated small losses from easy backgrounds. Training focuses on uninformative easy negatives instead of hard positives.

**Focal loss solution:**

Focal loss modulates loss by **(1 - p_t)^γ:**
- Easy backgrounds (p_t ≈ 1.0) → (1 - p_t)^γ ≈ 0 → **heavily down-weighted**
- Hard examples (p_t ≈ 0.5) → (1 - p_t)^γ ≈ larger value → **get more weight**

**Effect:** Model focuses on difficult examples instead of wasting gradients on easy backgrounds.

---

**Q: Explain why ordinary training can become biased and how focal loss attempts to address the problem. (short)**

**A:**

**Ordinary training bias:** With 50,000 easy backgrounds vs. 50 positives, total loss is dominated by accumulated small losses from easy negatives (correctly classified with high confidence). The model learns to ignore hard positives because their gradient contribution is overwhelmed.

**Focal loss solution:** Applies a down-weighting factor (1 - p_t)^γ to each example's loss. Easy backgrounds (high confidence) get heavily down-weighted; hard examples (low confidence) retain full weight. Training focuses on difficult cases.

**Result:** Improved accuracy on hard positives and false positives despite extreme class imbalance.

---

### Non-Maximum Suppression (NMS) Trade-offs

**Q: Two people are standing close together and their true boxes overlap considerably. Which statement best captures the NMS trade-off?**

Options:
- Aggressive suppression always improves recall because it creates additional boxes.
- Weak suppression guarantees exactly one detection per object.
- Very aggressive suppression can remove a genuine nearby person and reduce recall; very weak suppression can leave multiple duplicate boxes for the same object.
- NMS thresholds affect only image brightness, not which detections survive.

**A:** Option 3 is correct.

**The NMS trade-off:**

**Aggressive NMS (low IoU threshold, e.g., 0.3):**
- Suppresses any detection overlapping top-scoring box by >30%
- Two people standing close → their boxes naturally overlap
- Aggressive NMS removes second person's detection as "duplicate" → false negative
- Result: Reduced recall (missing genuine objects)

**Weak NMS (high IoU threshold, e.g., 0.9):**
- Only suppresses detections with very high overlap (>90%)
- Multiple detections on the *same* person can survive if pairwise IoU < 0.9
- Result: Multiple boxes per object → reduced precision

---

**Q: Explain why an overly aggressive NMS setting can reduce recall in such a scene. What happens at the opposite extreme if suppression is too weak? (3 lines)**

**A:**

**Aggressive NMS:** Two people standing close have overlapping boxes. Aggressive NMS suppresses the lower-confidence box as a "duplicate," removing a genuine detection → reduced recall.

**Weak NMS:** Multiple detections on the same person survive if their overlap is below the high threshold → multiple boxes per object → reduced precision.

**Trade-off:** No single threshold simultaneously keeps overlapping ground-truth objects and removes duplicate predictions.

---

### Faster R-CNN

**Q: A Faster R-CNN system has an excellent second-stage classifier, but it still misses many objects. Inspection reveals that the missing objects are rarely proposed by the RPN. Why can the second stage not recover these objects?**

Options:
- The second stage independently rescans every pixel and therefore does not depend on proposals.
- RPN proposals are used only for visualization and do not affect second-stage inputs.
- The second stage only classifies/refines proposals it receives; an object absent from the proposal set is effectively unavailable to that stage.
- ROIAlign generates missing proposals automatically from the ground truth during inference.

**A:** Option 3 is correct.

**Why:**

Faster R-CNN is a two-stage pipeline with hard dependency:
1. **RPN:** Generates candidate regions
2. **Second stage:** Only classifies/refines those proposals

**The bottleneck:** If an object is not proposed by the RPN, it never reaches the second stage. The second stage cannot rescan or generate new proposals.

**Result:** A perfect second-stage classifier cannot compensate for poor RPN. Improving the RPN is necessary.

---

**Q: Explain why the second stage cannot recover from this failure. (short, max 2 lines)**

**A:**

**Pipeline dependency:** RPN generates proposals → second stage only processes those proposals. If an object is missing from the proposal set, it never reaches the second stage.

**Second stage limitation:** Cannot independently rescan the image or generate new proposals; it only classifies/refines what it receives as input.

---

### ROIAlign/Crop-and-Resize

**Q: Faster R-CNN applies ROIAlign/crop-and-resize after the RPN. What is the main reason for this operation?**

Options:
- To calculate a global image histogram for all proposals together.
- To convert every proposal into a region-specific aligned feature representation suitable for shared second-stage classification/refinement.
- To remove the need for an RPN by proposing new objects from raw pixels.
- To perform NMS by changing the spatial resolution of the entire feature map.

**A:** Option 2 is correct.

**Why ROIAlign/crop-and-resize:**

**Problem:** RPN generates variable-sized proposals. The second stage expects fixed-size inputs for shared fully connected layers.

**ROIAlign solution:**
1. Extract corresponding region from backbone's feature map
2. Use bilinear interpolation to preserve geometric alignment
3. Crop and resample to fixed output size (e.g., 7×7)
4. Output: One fixed-size feature map per proposal

**Result:** Variable-sized proposals → fixed-size aligned features that feed into shared classification/regression heads.

---

**Q: Why does Faster R-CNN need ROIAlign/crop-and-resize after the RPN instead of simply sending the entire feature map independently to every proposal classifier? (short)**

**A:**

**Computational waste:** Sending the entire feature map to every proposal's classifier would reprocess irrelevant regions thousands of times.

**Fixed input requirement:** The second stage uses shared fully connected layers that expect fixed-size inputs (e.g., 7×7 features). Variable-sized proposals cannot be fed directly to FC layers; ROIAlign standardizes all proposals to the same size.

**Result:** ROIAlign extracts only proposal-specific regions and resizes them to fixed dimensions, enabling efficient, shared second-stage computation across all proposals.

---

### Input Resolution Trade-offs

**Q: Increasing detector input resolution improves small-object detection but increases GPU memory, latency, and reduces allowable batch size. Which conclusion is most defensible?**

Options:
- Always use the highest possible resolution because deployment constraints are irrelevant once accuracy improves.
- Lower resolution always improves small-object recall.
- Resolution should be selected as a speed/accuracy/memory trade-off based on the deployment requirements, not maximized blindly.
- Input resolution cannot affect detector latency or memory.

**A:** Option 3 is correct.

**The trade-off:**

**Higher resolution benefits:**
- Small objects occupy more pixels → better feature representation
- Improved small-object recall and AP

**Higher resolution costs:**
- More pixels → more convolution operations → **higher latency**
- Larger feature maps → **more GPU memory**
- Less room in batch → **reduced batch size**
- Slower inference

**Deployment context matters:**
- **Edge camera (latency-critical):** May require 480p instead of 1080p
- **Offline inspection system:** Can afford 1080p or higher
- **Mobile device:** Severely limited memory

---

**Q: Explain why "use the highest resolution possible" is not a sensible universal strategy (short)**

**A:**

**Resolution trades off accuracy against latency, memory, and batch size.** Higher resolution improves small-object detection but increases GPU memory, latency, and reduces allowable batch size—making it infeasible for edge deployment.

**Different applications have different constraints:** Edge cameras need low latency; offline systems can afford slower inference. Blindly maximizing resolution sacrifices practical deployability without considering the actual deployment environment.

---

## Segmentation

### Classification vs Detection vs Segmentation

**Q: A street image contains 3 pedestrians, 4 cars, road, sky, and grass. Which description is correct?**

Options:
- Semantic segmentation separates every car instance; instance segmentation merges all cars; panoptic segmentation ignores stuff classes.
- Semantic segmentation assigns class labels per pixel; instance segmentation also separates individual countable objects; panoptic segmentation combines instance-level "things" with semantic "stuff".
- Panoptic segmentation is identical to image classification because it produces one scene label.
- Instance segmentation is used only for stuff classes such as sky and road.

**A:** Option 2 is correct.

**The three tasks:**

**Semantic Segmentation:**
- Per-pixel class labels
- 3 pedestrians → all labeled "pedestrian" (no instance distinction)
- 4 cars → all labeled "car" (merged)

**Instance Segmentation:**
- Per-pixel class + instance ID
- 3 pedestrians → person_1, person_2, person_3
- 4 cars → car_1, car_2, car_3, car_4
- Works only for countable "things"; ignores "stuff"

**Panoptic Segmentation:**
- Combines both approaches
- **"Things" (instances):** person_1/2/3, car_1/2/3/4
- **"Stuff" (semantic):** road, sky, grass (no instance distinction)

---

**Q: Explain how the output representation would differ under: 1. semantic segmentation, 2. instance segmentation, 3. panoptic segmentation. (short)**

**A:**

**Semantic Segmentation:** Per-pixel class labels only: {person, person, person, car, car, car, car, road, sky, grass}. All pedestrians merge; all cars merge.

**Instance Segmentation:** Per-pixel class + instance ID for countable objects: {person_1, person_2, person_3, car_1, car_2, car_3, car_4}. Separates individual people and cars; ignores stuff classes.

**Panoptic Segmentation:** Per-pixel unified label encoding both instance (for things) and class (for stuff): {person_1, person_2, person_3, car_1, car_2, car_3, car_4, road, sky, grass}.

---

### Output Shapes

**Q: A network segments a 512×256 image into 8 semantic classes. Which pair of output shapes is conceptually correct?**

Options:
- Before argmax: 512×256×8; after argmax: 512×256.
- Before argmax: 512×256; after argmax: 8.
- Before argmax: 8×8; after argmax: 512×256×3.
- Before argmax: 512×8; after argmax: 256×8.

**A:** Option 1 is correct.

**Before argmax: 512×256×8**
- 512×256 = spatial dimensions (image pixels)
- 8 = one logit/probability per class
- Each pixel has 8 confidence scores

**After argmax: 512×256**
- 512×256 = spatial dimensions
- One integer label per pixel (0–7)
- Argmax collapses the 8 class scores into a single predicted class per pixel

---

**Q: State the conceptual output shape: 1. immediately before argmax, 2. after argmax. Explain what the dimensions mean. (short)**

**A:**

**Before argmax: 512×256×8**
- 512×256 = spatial dimensions (image pixels)
- 8 = one logit/probability per class
- Each pixel has 8 confidence scores

**After argmax: 512×256**
- 512×256 = spatial dimensions
- One integer label per pixel (0–7, representing the class with highest confidence)
- Argmax collapses the 8 class scores into a single predicted class per pixel.

---

## Deep Learning Architectures

### The WHAT-vs-WHERE Dilemma

**Q: An early CNN feature map precisely preserves edges but cannot distinguish a car from a wall. A deep feature map recognizes a car but localizes its boundary poorly. Which interpretation matches the WHAT-vs-WHERE dilemma?**

Options:
- Early layers retain WHERE/spatial detail but weaker semantics, while deep layers provide stronger WHAT/semantic meaning at coarser spatial resolution.
- Early and deep layers contain exactly the same information at the same resolution.
- Deep layers always preserve sharper boundaries than early layers because downsampling increases spatial precision.
- The dilemma is about choosing RGB versus CMYK.

**A:** Option 1 is correct.

**The WHAT-vs-WHERE trade-off:**

**Early CNN layers:**
- High spatial resolution (small downsampling)
- Preserve edges and fine-grained boundaries (WHERE)
- Limited semantic context (cannot distinguish car from wall)
- Learn low-level features (gradients, textures)

**Deep CNN layers:**
- Low spatial resolution (aggressive downsampling)
- Strong semantic recognition (WHAT)
- Can classify what an object is
- Poor localization (boundaries blurred)

**Why:** Downsampling compresses spatial information to make room for semantic learning.

---

**Q: Explain how this illustrates the WHAT vs WHERE problem. (short)**

**A:**

**WHAT problem:** Deep layers recognize "car" semantically (good semantic understanding) but lose boundary precision through downsampling.

**WHERE problem:** Early layers preserve sharp edges and boundaries (good spatial detail) but lack semantic context to distinguish car from wall.

**The dilemma:** Downsampling enables semantic learning (WHAT) but destroys spatial precision (WHERE). You cannot maximize both simultaneously—deeper networks trade spatial resolution for semantic richness. Solving this requires multi-scale fusion (FPN, skip connections).

---

### FPN (Feature Pyramid Network)

**Q: A detector performs well on large buses but frequently misses tiny distant motorcycles. Why could an FPN help?**

Options:
- It combines semantically strong features with multiple spatial resolutions, giving small objects access to higher-resolution representations.
- It removes all high-resolution feature maps so only the deepest map is used.
- It replaces object detection with image classification.
- It changes only the confidence threshold and does not modify features.

**A:** Option 1 is correct.

**Why motorcycles are missed without FPN:**

Standard CNN backbones have a **resolution-semantics trade-off:**
- **Deep layers:** Strong semantics but low spatial resolution → small objects become 1-2 pixels
- **Shallow layers:** High resolution but weak semantics → harder to distinguish motorcycles from clutter

**FPN solution:**

Builds a multi-scale feature pyramid:
- **Bottom-up pathway:** Standard backbone feature extraction
- **Top-down pathway + lateral connections:** Upsamples and fuses high-level semantic features with high-resolution shallow features
- **Result:** Each detection layer has both rich semantics AND spatial resolution

**Effect:** Small objects "live" at high-resolution detection levels with sufficient semantic context.

---

**Q: Why could an FPN help, even if the backbone already produces strong deep features? (short)**

**A:**

**Deep features alone are semantically rich but spatially downsampled:** Tiny motorcycles occupy only 1-2 pixels at deep resolution levels and vanish.

**FPN fuses deep semantics with shallow resolution:** Upsamples rich features and combines them with high-resolution shallow layers. Small objects now have both semantic context AND sufficient spatial resolution to be detected.

---

### U-Net Architecture

**Q: A decoder receives strong semantic features but produces blurry masks. Why can an encoder-to-decoder skip connection help?**

Options:
- It suppresses duplicate object-detection boxes before segmentation.
- It removes all encoder features so the decoder relies only on class labels.
- It transfers higher-resolution spatial details such as edges and boundaries that complement the decoder's coarse semantic features.
- It changes the loss from IoU to AP.

**A:** Option 3 is correct.

**Why skip connections solve blurry masks:**

**Problem:**
- Decoder has strong semantics (knows it's segmenting a car)
- Operates on low-resolution features (coarse spatial map)
- Result: Blurry boundaries

**Skip connection solution:**
- Connects high-resolution encoder features directly to corresponding decoder layers
- Early encoder features preserve edges and fine spatial details (WHERE)
- Decoder combines:
  - Low-resolution semantic features from deeper layers (WHAT)
  - High-resolution spatial details from skip connections (WHERE)
- Result: Sharp masks with correct semantics

---

**Q: Explain why adding an encoder-to-decoder skip connection can improve the output even though the decoder already "knows" the object class. (short)**

**A:**

**Semantic knowledge alone is insufficient:** Knowing "this is a car" doesn't specify the precise boundary pixels. The decoder needs spatial detail.

**Skip connections provide WHERE:** High-resolution encoder features preserve edges and boundary details that the decoder lost through downsampling.

**Combined WHAT + WHERE:** Decoder fuses its semantic understanding (what to segment) with spatial precision from skip connections (where exactly to segment) → sharp, accurate masks.

---

**Q: A U-Net contains a contracting path, bottleneck, expanding path, and skip connections. Which summary is correct?**

Options:
- The contracting path predicts the final mask directly, while the expanding path performs object-detection NMS.
- The contracting path builds semantic features while reducing resolution, the bottleneck is the most compressed semantic representation, the expanding path reconstructs dense predictions, and skips reintroduce high-resolution details.
- Skip connections are used only to reduce class imbalance in the loss.
- The bottleneck preserves the original image pixel-for-pixel, making skips unnecessary.

**A:** Option 2 is correct.

**U-Net architecture:**

**Contracting path (encoder):**
- Downsamples through convolutions and pooling
- Builds hierarchical semantic features
- Resolution decreases; semantic richness increases

**Bottleneck:**
- Most downsampled layer
- Strongest semantic representation
- Lowest spatial resolution

**Expanding path (decoder):**
- Upsamples through transpose convolutions
- Reconstructs spatial resolution progressively
- Produces dense predictions (segmentation map)

**Skip connections:**
- Connect each contracting layer to corresponding expanding layer
- Transfer high-resolution spatial details
- Concatenated with upsampled decoder features
- Enable precise predictions while retaining semantics

---

**Q: Explain the different jobs of: U-Net contracting path, bottleneck, expanding path, skip connections. Why would removing the skips fundamentally change the model's ability to recover fine structures? (short)**

**A:**

**Contracting path:** Downsamples and extracts semantic features (WHAT); loses spatial resolution.

**Bottleneck:** Strongest semantic representation at lowest resolution; heavy compression.

**Expanding path:** Upsamples and reconstructs spatial resolution; produces dense predictions.

**Skip connections:** Bypass the bottleneck; transfer high-resolution encoder details (edges, boundaries) directly to decoder.

**Why removing skips breaks fine structures:** Without skips, the decoder only has low-resolution bottleneck features and upsampling operations. Upsampling cannot recover fine spatial details already discarded—you cannot recreate information that was lost during downsampling. Skips are essential because they preserve the original high-resolution spatial information needed to recover sharp boundaries and fine structures.

---

### ASPP (Atrous Spatial Pyramid Pooling)

**Q: A single image contains the same object class at very different physical sizes. Why can ASPP be useful?**

Options:
- ASPP uses a single fixed dilation rate to force all objects into one scale.
- ASPP is a post-processing method that removes duplicate detection boxes.
- ASPP intentionally eliminates all contextual information and uses only local pixels.
- Parallel atrous convolutions with different dilation rates capture context at multiple effective scales, whereas one rate gives only one context scale.

**A:** Option 4 is correct.

**Why ASPP handles multi-scale objects:**

**Single fixed dilation (without ASPP):**
- Fixed dilation rate → fixed receptive field size
- Small object → receptive field too large
- Large object → receptive field too small
- **Problem:** One dilation cannot serve both scales

**ASPP (Atrous Spatial Pyramid Pooling):**
- Parallel branches with different dilation rates (e.g., 1, 6, 12, 18)
- Small dilations → small receptive fields → capture fine local detail (small objects)
- Large dilations → large receptive fields → capture broad context (large objects)
- All branches concatenated together
- Model adaptively learns which scale is relevant for each spatial region

---

**Q: Why might one dilation rate be insufficient? Explain how ASPP addresses this. (short)**

**A:**

**Single dilation problem:** Fixed dilation rate → fixed receptive field. Small objects get overwhelmed by too-large context; large objects don't get enough context. One scale cannot serve both.

**ASPP solution:** Parallel branches with multiple dilation rates (1, 6, 12, 18) simultaneously capture contexts at different scales. Small dilations handle fine detail (small objects); large dilations capture broad context (large objects). Concatenate all outputs → model learns which scale matters for each region.

**Result:** Multi-scale object segmentation in one layer without choosing a single "best" dilation rate.

---

### DeepLabv3+

**Q: A DeepLab-style model has strong multi-scale context but still produces inaccurate object boundaries. Which component pairing best matches the intended roles in DeepLabv3+?**

Options:
- ASPP/dilated context modules address multi-scale contextual understanding, while the decoder uses finer features to refine boundaries.
- NMS provides multi-scale context and focal loss reconstructs boundaries.
- ROIAlign provides semantic context and HOF restores edges.
- Histogram equalization provides context and JPEG quantization provides boundary refinement.

**A:** Option 1 is correct.

**DeepLabv3+ architecture:**

**ASPP (encoder):**
- Parallel atrous convolutions with multiple dilation rates (1, 6, 12, 18)
- Captures multi-scale contextual information (WHAT)
- Outputs low-resolution semantic features

**Decoder:**
- Upsamples ASPP output progressively
- Fuses with high-resolution features from early encoder layers (skip connections)
- Refines boundaries using fine spatial details (WHERE)
- Produces dense, sharp segmentation map

**The pairing strategy:**
- **ASPP** = semantic richness at multiple scales
- **Decoder** = spatial refinement

---

**Q: Which part of the architecture/story addresses contextual understanding, and which part addresses boundary refinement? (short)**

**A:**

**Contextual understanding: ASPP (encoder)** — Parallel atrous convolutions with different dilation rates (1, 6, 12, 18) capture multi-scale semantic context (WHAT).

**Boundary refinement: Decoder** — Upsamples ASPP features and fuses them with high-resolution skip connections from early encoder layers to sharpen object boundaries (WHERE).

**Result:** Semantics + spatial precision = accurate segmentation.

---

### Transformers for Dense Prediction

**Q: A small local patch could plausibly belong to either a river, a dark road, or a shadow. Why might a transformer-based segmentation architecture help?**

Options:
- Transformers guarantee correct labels by ignoring the rest of the image.
- Attention can let distant scene regions influence the representation, providing global context that can disambiguate locally similar appearances.
- Global context is unnecessary when local texture is ambiguous.
- Transformers work only by increasing image brightness.

**A:** Option 2 is correct.

**Why local patches are ambiguous:**

A small dark patch looks identical in texture/color whether it's:
- A river (water)
- A dark asphalt road
- A shadow cast by a building

**CNN limitation:** Needs deep layers to gather global context. Early layers have small receptive fields; deep layers provide context but sacrifice spatial precision.

**Transformer advantage:** Self-attention operates globally from the start. Every position can attend to every other position, providing **instant global context**.

**How context resolves ambiguity:**
- **River patch:** Nearby regions show water, sky, vegetation
- **Road patch:** Nearby regions show lane markings, cars, buildings
- **Shadow patch:** Nearby lit surfaces with sharp boundary

---

**Q: Why might a transformer-based segmentation architecture have an advantage over a model relying only on very local evidence? (short)**

**A:**

**Local evidence is ambiguous:** A dark patch could be river, road, or shadow—identical appearance locally.

**Transformer advantage:** Self-attention lets every patch attend to distant regions globally from the start. A dark patch can immediately aggregate context from surrounding water/vegetation (river), lane markings/cars (road), or lit surfaces with sharp boundaries (shadow).

**CNN limitation:** Needs many deep layers to gather global context; early layers have small receptive fields.

**Result:** Transformers resolve ambiguity early; CNNs need depth to achieve the same global understanding.

---

### Mask Classification

**Q: Traditional semantic segmentation predicts class scores at each pixel. Mask-classification approaches instead reason in terms of predicted regions/masks with associated classes. What conceptual advantage can this provide?**

Options:
- It eliminates all need for spatial masks and predicts only image-level labels.
- It guarantees every predicted mask corresponds to exactly one ground-truth instance without training.
- It is equivalent to applying a global intensity histogram before argmax.
- It allows the model to treat a coherent region as a structured prediction unit, linking mask geometry with class identity rather than considering every pixel only in isolation.

**A:** Option 4 is correct.

**Why mask-classification is conceptually different:**

**Traditional per-pixel segmentation:**
- Each pixel independently predicts its class
- No explicit link between spatial coherence and class label
- Can produce noisy, inconsistent predictions

**Mask-classification approach:**
- First predicts a set of coherent regions/masks (binary masks)
- Then associates each mask with a class label
- **Key insight:** Mask geometry and class label are linked as one unit
- Enforces spatial consistency within predicted regions

**Advantages:**
1. **Spatial coherence:** Each predicted region is spatially connected
2. **Region-level reasoning:** Can leverage region properties (size, shape, boundaries)
3. **Fewer isolated errors:** Noise in individual pixels less impactful at region level
4. **Cleaner predictions:** Regions naturally enforce smoothness

---

**Q: What conceptual advantage can arise from treating a region as a structured entity rather than making every pixel decision independently? (short)**

**A:**

**Spatial coherence:** Regions enforce consistency by design. Related pixels within a region are predicted as one unit, avoiding isolated noisy pixel flips.

**Region-level reasoning:** Class prediction can leverage regional properties (size, shape, boundaries, texture continuity) rather than treating each pixel in isolation.

**Cleaner outputs:** Spatially structured predictions naturally produce smoother, more coherent segmentations without post-processing.

---

## Evaluation Metrics

### Pixel Accuracy vs Per-Class Metrics

**Q: Model A reports Pixel Accuracy=97%, while Model B reports Pixel Accuracy=94%. You are told nothing else. Which conclusion is scientifically defensible?**

Options:
- Model A is definitely superior on every class because its global pixel accuracy is higher.
- Model B is definitely better because lower accuracy implies better rare-class performance.
- Pixel accuracy alone reveals boundary quality and class-specific failure modes.
- The comparison is incomplete; request per-class IoU/Dice (and mIoU) because overall accuracy can be dominated by frequent classes.

**A:** Option 4 is correct.

**Why pixel accuracy is misleading:**

**Scenario:** Image with 98% background, 2% foreground object
- Model A: Predicts everything as background → 98% pixel accuracy, 0% on foreground
- Model B: 95% background accuracy, 80% foreground accuracy → ~95.6% pixel accuracy

Model A appears superior but completely fails on the rare class.

**The fundamental problem:**
Pixel accuracy is a simple average weighted by class frequency. Frequent classes dominate; rare classes have minimal impact.

**What you need instead:**
- **Per-class IoU:** Intersection over Union for each class
- **mIoU (mean IoU):** Average IoU across all classes (equal weight)
- **Per-class Dice:** Alternative boundary-aware metric

---

**Q: Explain why it is scientifically invalid to immediately claim that Model A is a better semantic-segmentation system. What additional class-wise information would you request? (short)**

**A:**

**Why pixel accuracy is invalid:** Dominated by frequent classes. Model A's 97% might simply mean it's better at predicting common backgrounds while failing on rare foreground objects.

**Additional class-wise information to request:**
- **Per-class IoU:** Intersection over Union for each semantic class separately
- **mIoU (mean IoU):** Average IoU across all classes, giving equal weight regardless of frequency
- **Per-class Dice/F1:** Boundary-aware metric per class
- **Confusion matrix:** Which classes does each model confuse?

**Example:** Model B might have higher mIoU despite lower pixel accuracy if it performs much better on rare classes.

---

### Precision and Recall

**Q: A test set contains 120 real objects. A detector produces 100 detections: 72 correctly match real objects and 28 are incorrect detections. Assume the remaining real objects were missed. Which precision/recall pair is correct?**

Options:
- Precision = 72%, Recall = 60%.
- Precision = 60%, Recall = 72%.
- Precision = 72%, Recall = 72%.
- Precision = 60%, Recall = 60%.

**A:** Option 1 is correct.

**Calculation:**

**Given:**
- Ground truth: 120 real objects
- Detections: 100 total (TP: 72, FP: 28)
- False negatives: 120 - 72 = 48

**Precision:**
```
Precision = TP / (TP + FP) = 72 / 100 = 72%
```

**Recall:**
```
Recall = TP / (TP + FN) = 72 / 120 = 60%
```

**Interpretation:**
- Precision = 72%: Of 100 detections, 72 were correct
- Recall = 60%: Of 120 real objects, 60 were detected; 48 were missed

---

**Q: Calculate: 1. precision, 2. recall, and explain which error type each metric exposes. (short)**

**A:**

**Precision = 72/100 = 72%** — Exposes false positives: Of 100 predictions, 28 were wrong (incorrect detections).

**Recall = 72/120 = 60%** — Exposes false negatives: Of 120 ground truth objects, 48 were missed.

**In practice:** High precision, low recall = detector is conservative (few false alarms but misses objects); low precision, high recall = detector is permissive (finds objects but generates many false alarms).

---

### Average Precision (AP) at Different IoU Thresholds

**Q: A detector achieves AP@0.5=0.93 but AP@0.75=0.57. The detector clearly knows where objects approximately are. What additional conclusion is most justified?**

Options:
- The detector localizes boxes very precisely because performance is unchanged at stricter IoU.
- The detector's boxes are often not tight/precise enough to satisfy the stricter IoU criterion.
- The detector must have zero false positives at IoU 0.75.
- AP at different IoU thresholds says nothing about localization quality.

**A:** Option 2 is correct.

**Analysis:**

**AP@0.5 = 0.93:** At loose IoU threshold, most detections count as correct. High performance indicates the detector finds objects and produces boxes with *roughly* correct position/size.

**AP@0.75 = 0.57:** At strict IoU threshold, many detections no longer count as correct. Dramatic drop reveals that boxes lose sufficient overlap when stricter alignment is demanded.

**Conclusion:** The detector knows *approximately* where objects are but produces **loose/imprecise** bounding boxes. They overlap enough at IoU 0.5 but fail at IoU 0.75.

**This exposes:** Good object detection (finds objects) + poor box regression (coordinates not tight).

---

## Domain and Robustness

### Domain Shift

**Q: A model trained on daytime road scenes achieves strong mIoU. At night, performance collapses even though the classes have not changed. Which interpretation and response are most appropriate?**

Options:
- This proves the model has discovered new semantic classes, so the only solution is to increase the output class count.
- This is an NMS failure because every nighttime pixel becomes a duplicate box.
- This is domain shift rather than a new-class problem; use approaches such as illumination/data augmentation, domain adaptation, or related robustness methods.
- No action is needed because the label set is unchanged.

**A:** Option 3 is correct.

**Why this is domain shift, not a new-class problem:**

**Classes are identical:** Road, car, person, building, etc. are the same by day and night.

**The problem is visual appearance:** Daytime → bright, high contrast, clear textures. Nighttime → dark, low contrast, shadows, reflections, artificial lighting. The model overfits to daytime visual patterns.

**Domain shift characteristics:**
- Model fails because it's operating outside its training distribution
- Features that work day don't transfer to night

**Appropriate solutions:**

1. **Data augmentation:** Simulate nighttime conditions synthetically
2. **Diverse training data:** Include both daytime and nighttime scenes during training
3. **Domain adaptation:** Use adversarial learning to learn domain-invariant features
4. **Transfer learning:** Pretrain on large varied datasets
5. **Test-time augmentation:** Apply multiple augmentations and ensemble

---

**Q: Explain: 1. why this is not simply a new-class problem, 2. what kind of failure it represents, 3. two approaches that might improve robustness. (short)**

**A:**

**1. Not a new-class problem:** Classes (road, car, person) are identical; only visual appearance changed from day to night.

**2. Failure type:** Domain shift—model overfitted to daytime visual patterns (lighting, contrast, textures) and cannot generalize to a different visual distribution (nighttime).

**3. Two robustness approaches:**
- **Data augmentation:** Darken training images, reduce contrast, simulate nighttime conditions synthetically
- **Diverse training data:** Include both daytime and nighttime scenes during training to learn lighting-invariant features

---

## End of Study Guide

This comprehensive guide covers the fundamental concepts, trade-offs, and practical considerations in computer vision. Review each section to reinforce understanding of the WHAT-vs-WHERE dilemma, multi-scale architectures, evaluation metrics, and domain robustness principles.