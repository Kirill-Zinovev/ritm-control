const tile = 627, baseline = .91, baseFloor = 571;
const radians = degrees => degrees * Math.PI / 180;
const unit = v => Math.min(1, Math.max(0, v));
const ease = v => { const t = unit(v); return t * t * (3 - 2 * t); };
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const length = v => Math.hypot(...v);
const angle = v => Math.atan2(v[1], v[0]);
const extend = (point, radians, distance) => add(point, [Math.cos(radians) * distance, Math.sin(radians) * distance]);
const rotate = (p, r) => [Math.cos(r)*p[0]-Math.sin(r)*p[1], Math.sin(r)*p[0]+Math.cos(r)*p[1]];

// Source coordinates in two cells of one atlas. Every cutout is sampled
// once at startup. Only the skeleton moves during playback.
const hip = [340, 410], neck = [348, 227];
const nearArm = [[302,280],[230,246],[159,219]];
const farArm = [[401,251],[454,227],[516,202]];
const nearLeg = [[319,405],[281,474],[259,540]];
const farLeg = [[360,412],[355,476],[353,540]];
const tailPivot = [321,398];

function texturedPart(atlas, cell, points) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = tile;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const vertex of points.slice(1)) ctx.lineTo(...vertex);
  ctx.closePath();
  ctx.clip();
  const w = atlas.naturalWidth / 2, h = atlas.naturalHeight / 2;
  ctx.drawImage(atlas, cell * w, 0, w, h, 0, 0, tile, tile);
  return canvas;
}

function fixed(ctx, texture, from, to, rotation = 0) {
  ctx.save();
  ctx.translate(...to);
  ctx.rotate(rotation);
  ctx.translate(-from[0], -from[1]);
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}

function bone(ctx, texture, fromA, fromB, a, b) {
  const original = sub(fromB, fromA), posed = sub(b, a);
  ctx.save();
  ctx.translate(...a);
  ctx.rotate(angle(posed));
  ctx.scale(length(posed) / length(original), 1);
  ctx.rotate(-angle(original));
  ctx.translate(-fromA[0],-fromA[1]);
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}

function bentKnee(upper, foot, first, second) {
  const delta = sub(foot, upper);
  const distance = Math.min(first + second - .12, Math.max(Math.abs(first - second) + .12, length(delta)));
  const along = (first ** 2 - second ** 2 + distance ** 2) / (2 * distance);
  const perpendicular = Math.sqrt(Math.max(0, first ** 2 - along ** 2));
  const axis = angle(delta);
  return add(extend(upper, axis, along), [Math.sin(axis) * perpendicular, -Math.cos(axis) * perpendicular]);
}

// root x/y, torso/head pitch, arm angles, then flight ankle offsets.
const choreography = [
  [0, 0,18, 5,5, 116,100, 57,76, 0,0,0,0],
  [.085, -2,14, 4,2, 123,107, 48,69, 0,0,0,0],
  [.19, -2,5, -2,-5, 181,208, -14,-35, 0,0,0,0],
  [.31, -1,-3, -4,-7, 238,252, -64,-76, 0,0,0,0],
  [.355, 0,-2, -3,-5, 236,250, -63,-73, 0,0,0,0],
  [.435, 2,3, 1,0, 128,106, 47,64, 0,0,0,0],
  [.56, -10,57, 15,-4, 159,179, 121,143, 0,0,0,0],
  [.605, 1,1, 13,-6, 84,15, 2,-22, -3,-8, 4,-17],
  [.70, 11,28, 13,-4, 147,155, -25,-13, -48,-49, 42,-105],
  [.765, 13,18, 11,3, 76,24, 10,12, -30,-31, 33,-49],
  [.82, 7,8, 7,5, 69,14, 22,34, 0,0,0,0],
  [.869, 9,55, 15,3, 60,33, 21,49, 0,0,0,0],
  [.935, 4,21, 6,2, 102,76, 45,58, 0,0,0,0],
  [1, 0,4, 1,0, 112,91, 55,66, 0,0,0,0],
];

function sample(p) {
  const index = choreography.findIndex(row => row[0] >= p);
  if (index <= 0) return choreography[index === 0 ? 0 : choreography.length - 1].slice(1);
  const start = choreography[index - 1], end = choreography[index];
  const blend = ease((p - start[0]) / (end[0] - start[0]));
  return start.slice(1).map((value, i) => value + (end[i + 1] - value) * blend);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLImageElement} atlas
 */
export function mountArkadyRig(canvas, atlas) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !atlas.naturalWidth || !atlas.naturalHeight) throw new Error('Не удалось загрузить персонажа.');
  const body = texturedPart(atlas, 1, [[251,220],[309,213],[400,220],[438,245],[430,269],[410,292],[403,304],[418,350],[416,378],[409,401],[388,425],[353,438],[317,435],[293,418],[277,392],[279,356],[281,323],[272,306],[253,286]]);
  const head = texturedPart(atlas, 0, [[193,20],[477,18],[480,204],[442,224],[405,236],[379,249],[339,251],[305,245],[278,234],[228,226],[193,211]]);
  const tail = texturedPart(atlas, 1, [[102,259],[204,240],[220,253],[245,275],[259,316],[252,352],[274,357],[317,363],[338,384],[334,418],[310,444],[113,447],[89,398]]);
  const arms = [
    {
      rest: nearArm,
      upper: texturedPart(atlas, 1, [[281,253],[324,254],[326,291],[298,313],[263,296],[209,262],[214,223],[239,219],[277,240]]),
      lower: texturedPart(atlas, 1, [[221,217],[245,223],[243,259],[221,272],[174,255],[116,239],[77,264],[66,211],[77,173],[113,165],[159,187],[204,206]]),
    },
    {
      rest: farArm,
      attachment: [406,268],
      upper: texturedPart(atlas, 1, [[388,242],[411,228],[440,215],[459,208],[479,212],[483,228],[468,242],[449,253],[433,266],[401,276],[385,268]]),
      lower: texturedPart(atlas, 1, [[440,220],[463,204],[479,181],[494,146],[527,142],[560,152],[571,212],[554,227],[525,231],[490,226],[461,245],[445,241]]),
    },
  ];
  const legs = [
    {
      rest: nearLeg,
      upper: texturedPart(atlas, 1, [[291,388],[331,390],[351,421],[317,474],[318,493],[266,482],[263,450],[281,413]]),
      lower: texturedPart(atlas, 1, [[269,461],[317,464],[316,494],[286,551],[238,550],[243,520]]),
      foot: texturedPart(atlas, 1, [[238,516],[281,524],[293,542],[309,546],[309,581],[199,581],[211,549]]),
    },
    {
      rest: farLeg,
      upper: texturedPart(atlas, 1, [[331,391],[391,390],[387,443],[379,490],[323,491],[324,453]]),
      lower: texturedPart(atlas, 1, [[329,459],[384,458],[380,540],[327,550]]),
      foot: texturedPart(atlas, 1, [[326,521],[380,516],[397,532],[429,536],[441,582],[313,582]]),
    },
  ];
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let current = 1;

  function draw(progress) {
    current = Number.isFinite(progress) ? unit(progress) : 1;
    const [x, y, pitch, glance, leftUpper, leftLower, rightUpper, rightLower, ax, ay, bx, by] = sample(current);
    const root = add(hip, [x, y]);
    const lean = radians(pitch);
    const attached = point => add(root, rotate(sub(point, hip), lean));
    const dimensions = Math.min(canvas.width, canvas.height);
    const scale = dimensions / tile;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, (canvas.width-dimensions)/2, (canvas.height-dimensions)/2 + (baseline*tile-baseFloor)*scale);
    ctx.imageSmoothingQuality = 'high';

    const drawLeg = (limb, dx, dy) => {
      const [origin, originalKnee, originalAnkle] = limb.rest;
      const top = attached(origin), foot = add(originalAnkle, [dx, dy]);
      const knee = bentKnee(top, foot, length(sub(originalKnee, origin)), length(sub(originalAnkle, originalKnee)));
      bone(ctx, limb.upper, origin, originalKnee, top, knee);
      bone(ctx, limb.lower, originalKnee, originalAnkle, knee, foot);
      fixed(ctx, limb.foot, originalAnkle, foot, radians(dy * .13));
    };
    const drawArm = (limb, upper, lower) => {
      const [origin, originalElbow, originalWrist] = limb.rest;
      const first = attached(limb.attachment || origin);
      const elbow = extend(first, radians(upper), length(sub(originalElbow, origin)));
      const wrist = extend(elbow, radians(lower), length(sub(originalWrist, originalElbow)));
      bone(ctx, limb.upper, origin, originalElbow, first, elbow);
      bone(ctx, limb.lower, originalElbow, originalWrist, elbow, wrist);
    };

    // Far limbs pass behind the torso. The tail and head lag the body on
    // takeoff and landing, while the toes stay fixed through the crouch.
    drawLeg(legs[1], bx, by);
    drawArm(arms[1], rightUpper, rightLower);
    const tailLag = Math.sin(Math.PI * ease((current - .56) / .26)) * -0.24 + Math.sin(current * Math.PI * 2) * .025;
    fixed(ctx, tail, tailPivot, attached(tailPivot), lean * .55 + tailLag);
    drawLeg(legs[0], ax, ay);
    fixed(ctx, body, hip, root, lean);
    fixed(ctx, head, neck, attached(neck), lean * .45 + radians(glance));
    drawArm(arms[0], leftUpper, leftLower);
  }

  function resize() {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    draw(current);
  }

  resize();
  return { draw, resize, bottom: () => baseline };
}
