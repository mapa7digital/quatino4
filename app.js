import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ==========================================================================
// Visualizador 3D + Realidade Aumentada para o modelo quati.fbx
//
// A RA agora usa MindAR (rastreamento de IMAGEM, via câmera). O quati aparece
// em cima da imagem-alvo (alvo.jpg). O arquivo targets.mind é a versão "compilada" dessa imagem —
// se trocar a imagem, gere outro .mind em
// https://hiukim.github.io/mind-ar-js-doc/tools/compile
//
// A animação de entrada (deslizamento) do modelo "de mesa" foi retirada
// daqui e vive em ./modules/entranceAnimation.js — veja aquele arquivo se
// quiser reativá-la.
// ==========================================================================

// Alvo da RA: alvo.jpg (1136x1598) é a FOTO DA MAQUETE, e targets.mind é essa MESMA
// imagem compilada para o MindAR. Se trocar a imagem, recompile o .mind
// (o .mind e a imagem precisam ser sempre o mesmo par, senão a RA não reconhece nada).
// Modelo 3D exibido (FBX: traz geometria e texturas embutidas no próprio arquivo)
const MODEL_URL = './quati.fbx';

const AR_TARGET_IMAGE_URL = './alvo.jpg';
const AR_TARGET_MIND_URL = './targets.mind';
// Tamanho do quati na RA em relação à LARGURA da maquete (1 = mesma largura; 0.4 = 40%)
// (antes era 0.2; dobrado). Dá para testar na URL sem editar o código: ?caps=0.5
const AR_MODEL_SCALE = 0.4;

// ---------- Onde o quati fica na maquete ----------
// Coordenadas em PIXELS da foto alvo.jpg (origem no canto superior esquerdo).
// Padrão: gramado verde-claro ao lado do rio, na parte de cima da maquete.
// Dá para testar outras posições sem editar o código, pela URL:
//   ?capx=600&capy=610&caps=0.2&caph=90
//   capx/capy = posição em pixels da foto | caps = tamanho (fração da largura) | caph = direção em graus
const AR_TARGET_PX_W = 1136;
const AR_TARGET_PX_H = 1598;
const AR_CAPY_PIXEL = { x: 600, y: 610 };
const AR_CAPY_HEADING_DEG = 0;   // para onde o quati olha (gira em torno do eixo vertical)
// Na RA o quati também gira sozinha sobre a maquete. Mude para false se preferir
// que ela fique parada (como um animal pastando).
const AR_AUTO_ROTATE = true;   // (a velocidade é MODEL_ROTATION_SPEED, mais abaixo)

const _qs = new URLSearchParams(location.search);
const _num = (k, d) => (_qs.has(k) && isFinite(parseFloat(_qs.get(k)))) ? parseFloat(_qs.get(k)) : d;
const CAPY_PX = { x: _num('capx', AR_CAPY_PIXEL.x), y: _num('capy', AR_CAPY_PIXEL.y) };
const CAPY_SCALE = _num('caps', AR_MODEL_SCALE);
const CAPY_HEADING = THREE.MathUtils.degToRad(_num('caph', AR_CAPY_HEADING_DEG));

// ---------- Suavização do rastreamento (anti-tremor) ----------
// O rastreamento de imagem entrega a posição da câmera em "degraus" e com
// ruído. Em vez de colar o quati direto nesses valores, ela segue a
// imagem por uma suavização exponencial, independente da taxa de quadros.
//   AR_SMOOTHING: maior = segue mais rápido (mais tremor); menor = mais macio (mais atraso).
//   Faixa útil: 4 (bem macio) a 15 (bem ágil).
const AR_SMOOTHING = 7;
// Filtro interno do MindAR (One Euro). Valores menores de FILTER_MIN_CF e
// FILTER_BETA reduzem o tremor, ao custo de um pequeno atraso ao mover.
const AR_FILTER_MIN_CF = 0.0001;
const AR_FILTER_BETA = 20;
// Quantos quadros sem ver a imagem antes de esconder o modelo (evita piscar)
const AR_MISS_TOLERANCE = 10;
const AR_WARMUP_TOLERANCE = 8;
// Se o rastreamento perder a imagem por um instante (borrão, reflexo, mão na frente),
// o quati fica na última posição por este tempo (segundos) em vez de sumir e
// reaparecer. Ela continua girando durante esse intervalo.
const AR_HOLD_SECONDS = 0.35;

// ---------- Desempenho: ajustes gerais ----------
// Limita a densidade de pixels: em telas 3x, renderizar a 3x é pesado e quase
// não melhora a imagem de um modelo 3D.
const MAX_PIXEL_RATIO = 2;
const AR_PIXEL_RATIO = 1.5;
// Texturas maiores que isso (em pixels) são reduzidas na carga: menos memória
// de GPU e menos travada no primeiro desenho.
const MAX_TEXTURE_SIZE = 1024;
// Piso da qualidade adaptativa: se o aparelho engasgar, o modo "de mesa" reduz a
// densidade de pixels aos poucos, até este valor.
const MIN_PIXEL_RATIO = 1;

// ---------- Aparência ----------
const TONE_EXPOSURE = 1.05;        // brilho geral do modelo (1 = neutro)
const SPIN_RESUME_DELAY_MS = 2200; // depois de soltar o arraste, a rotação automática volta após esse tempo

// A biblioteca do MindAR (com TensorFlow.js) é grande. Em vez de carregá-la
// junto com a página, ela é importada só quando precisa — e pré-carregada em
// segundo plano quando o navegador está ocioso, para o botão responder rápido.
let mindarModulePromise = null;
function loadMindAR() {
    if (!mindarModulePromise) {
        mindarModulePromise = import('mindar-image-three').catch((err) => {
            mindarModulePromise = null; // permite tentar de novo
            throw err;
        });
    }
    return mindarModulePromise;
}

function whenIdle(fn) {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1500);
}

function reportFatal(msg) {
    console.error(msg);
    const box = document.getElementById('ar-warning');
    if (box) { box.style.display = 'block'; box.textContent = msg; }
}
window.addEventListener('unhandledrejection', (e) => reportFatal('Erro: ' + describeError(e.reason)));

const infoEl = document.getElementById('info-text');
const loadingEl = document.getElementById('loading');
const loadingTextEl = document.getElementById('loading-text');
const loadingBarEl = document.getElementById('loading-bar');
const arContainer = document.getElementById('ar-button-container');
const arWarning = document.getElementById('ar-warning');

// Some o "Carregando" com um fade rápido (a classe .done tem a transição no CSS)
function hideLoading() {
    if (!loadingEl) return;
    loadingEl.classList.add('done');
    setTimeout(() => { loadingEl.style.display = 'none'; }, 400);
}

const DEFAULT_INFO_TEXT = 'Arraste para girar, pince ou role para dar zoom';
const AR_INFO_TEXT = 'Aponte a câmera para a maquete (de cima, com boa luz) para ver o quati.';

// ==========================================================================
// ---------- MOVIMENTO: rotação automática e eixo vertical do modelo ----------
// Toda a lógica de "movimento" do modelo fica concentrada aqui, separada do
// resto do arquivo, para ficar fácil de achar e ajustar.
// ==========================================================================

// Rotação automática (gira sozinha, além do arraste manual do OrbitControls
// no modo "de mesa"). Isso é aplicado tanto no modelo "de mesa" quanto no
// modelo da RA, no loop de animação lá embaixo.
const MODEL_AUTO_ROTATE = true;      // true = o quati gira sozinho; false = fica parado até o usuário arrastar
const MODEL_ROTATION_SPEED = 0.6;    // radianos por segundo (≈ 34°/s) — velocidade da rotação automática
const MODEL_ROTATION_AXIS = 'y';     // eixo da rotação automática: 'x', 'y' ou 'z'

// Eixo vertical (Y) do modelo, usado para apoiar o quati sobre o marcador
// na RA. Alguns modelo são exportados com o eixo Y espelhado/invertido em
// relação ao que o three.js espera (Y crescendo para cima). Se o quati
// aparecer de cabeça para baixo, flutuando ou afundado no marcador, alterne
// este valor — é usado lá em setupARScene().
const INVERT_MODEL_Y = false;

// Relógio para calcular a rotação automática em radianos/segundo "de
// verdade", independente da taxa de quadros (FPS) do dispositivo.
const clock = new THREE.Clock();

// ==========================================================================
// ---------- Modo "de mesa" (visualização normal, fora da RA) ----------
// ==========================================================================
const scene = new THREE.Scene();
// Sem cor de fundo na cena: o fundo (gradiente) vem do CSS, atrás do canvas transparente.
scene.background = null;

const camera = new THREE.PerspectiveCamera(
    40,
    window.innerWidth / window.innerHeight,
    0.01,
    2000
);
camera.position.set(0, 0, 150);

let currentPixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);

const renderer = new THREE.WebGLRenderer({
    antialias: window.devicePixelRatio < 2, // em telas densas o antialias quase não se nota e custa caro
    alpha: true,
    powerPreference: 'high-performance'
});
renderer.setPixelRatio(currentPixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // cores mais ricas, sem estourar o brilho
renderer.toneMappingExposure = TONE_EXPOSURE;
document.body.appendChild(renderer.domElement);

// Controles de mouse/touch (arrastar para girar, scroll para zoom) - só
// fazem sentido no modo "de mesa", fora da sessão de RA.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;                 // arrastar de lado só faria o modelo sair da tela
controls.maxPolarAngle = Math.PI * 0.55;    // não deixa a câmera ir parar embaixo do chão

// Luzes do modo "de mesa": céu/chão suaves + luz principal quente + contraluz fria
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));

const keyLight = new THREE.DirectionalLight(0xfff4e0, 2.6);
keyLight.position.set(2.5, 4, 3);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xbfe3ff, 1.2);
rimLight.position.set(-3, 2, -3);
scene.add(rimLight);

// ---------- Rotação automática: pausa enquanto o usuário arrasta ----------
let userInteracting = false;
let userMovedCamera = false; // depois que o usuário mexe na câmera, não reenquadramos sozinhos
let spinFactor = 1;          // 0 = parado, 1 = girando; muda de forma suave
let resumeTimer = null;

controls.addEventListener('start', () => {
    userInteracting = true;
    userMovedCamera = true;
    clearTimeout(resumeTimer);
});
controls.addEventListener('end', () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { userInteracting = false; }, SPIN_RESUME_DELAY_MS);
});

// ---------- Enquadramento ----------
// Calcula a distância da câmera para o quati caber inteira na tela, seja em
// celular na vertical ou monitor largo, com uma leve inclinação de cima.
function frameModel() {
    if (!modelSize) return;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const radius = 0.4 * Math.hypot(modelSize.x, modelSize.y, modelSize.z);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1;
    const tilt = THREE.MathUtils.degToRad(14);

    camera.position.set(0, Math.sin(tilt) * dist, Math.cos(tilt) * dist);
    camera.near = dist / 100;
    camera.far = dist * 50;
    camera.updateProjectionMatrix();

    controls.target.set(0, 0, 0);
    controls.minDistance = dist * 0.4;
    controls.maxDistance = dist * 2.5;
    controls.update();
}

// ---------- Sombra de contato ----------
// Um disco macio sob o quati: dá sensação de apoio no chão sem custo de
// mapa de sombras (é só um plano com textura de gradiente).
function makeContactShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(20, 38, 30, 0.50)');
    grad.addColorStop(0.55, 'rgba(20, 38, 30, 0.20)');
    grad.addColorStop(1, 'rgba(20, 38, 30, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const size = Math.hypot(modelSize.x, modelSize.z) * 1.1;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -modelSize.y / 2 - modelMaxDim * 0.005;
    mesh.renderOrder = -1;
    return mesh;
}

// ---------- Qualidade adaptativa (modo "de mesa") ----------
// Se o aparelho passar mais de ~1,5 s abaixo de 40 fps, baixa a densidade de
// pixels em degraus de 0,25 até MIN_PIXEL_RATIO.
let slowTime = 0;
function adaptQuality(delta) {
    if (currentPixelRatio <= MIN_PIXEL_RATIO) return;
    slowTime = delta > 1 / 40 ? slowTime + delta : Math.max(0, slowTime - delta);
    if (slowTime > 1.5) {
        currentPixelRatio = Math.max(MIN_PIXEL_RATIO, currentPixelRatio - 0.25);
        renderer.setPixelRatio(currentPixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        slowTime = 0;
    }
}

// ---------- Estado do modelo carregado ----------
// modelObject é um "wrapper" (THREE.Group) que contém o objeto do modelo como
// filho. O objeto do modelo é centralizado dentro desse wrapper (equivalente ao
// que era feito com geometry.translate() no STL), enquanto o próprio
// wrapper fica em (0,0,0) — assim dá para reaproveitar o wrapper tanto no
// modo "de mesa" quanto (clonado) na RA, aplicando escala/posição/rotação
// nele sem bagunçar a centralização interna.
let modelObject = null;
let modelSize = null; // THREE.Vector3 com as dimensões do bounding box
let modelMaxDim = 1;
let previewMesh = null; // wrapper do modo "de mesa" (guardado para a rotação automática)

// Material usado como fallback para malhas do modelo que não trouxerem material
// próprio embutido no arquivo.
const FALLBACK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0xa9835a,
    metalness: 0.05,
    roughness: 0.85
});

// ---------- Otimização do modelo carregado ----------
function downscaleTexture(tex) {
    const img = tex && tex.image;
    if (!img || !img.width || !img.height) return;
    const biggest = Math.max(img.width, img.height);
    if (biggest <= MAX_TEXTURE_SIZE) return;
    const k = MAX_TEXTURE_SIZE / biggest;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    tex.image = c;
    tex.needsUpdate = true;
}

function optimizeModel(root) {
    const seen = new Set();
    root.traverse((child) => {
        if (child.isMesh) {
            // Sem sombras e sem animação neste visualizador: nada disso é necessário
            child.castShadow = false;
            child.receiveShadow = false;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                if (!m || seen.has(m)) return;
                seen.add(m);
                for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
                    if (m[key]) {
                        downscaleTexture(m[key]);
                        m[key].anisotropy = 4;
                    }
                }
            });
            // Calcula uma vez a esfera de corte (evita recalcular depois)
            if (child.geometry && !child.geometry.boundingSphere) child.geometry.computeBoundingSphere();
        }
    });
    // O modelo não tem animação: congela as matrizes dos filhos (o wrapper continua girando)
    root.updateMatrixWorld(true);
    root.traverse((child) => {
        if (child !== root) {
            child.matrixAutoUpdate = false;
        }
    });
}

// Força o upload das texturas para a GPU antes de elas serem necessárias.
// Cada renderer (o de mesa e o da RA) tem seu próprio contexto WebGL, então o
// upload precisa ser feito em cada um deles.
const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap'];
function warmUpTextures(root, rend = renderer) {
    root.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
            if (!m) return;
            TEXTURE_KEYS.forEach((key) => { if (m[key]) rend.initTexture(m[key]); });
        });
    });
}

// ---------- Carregamento do modelo ----------
const loader = new FBXLoader();

// O FBXLoader entrega as texturas embutidas de forma assíncrona (as imagens
// terminam de decodificar DEPOIS do callback de carga). Esperamos por elas antes de
// reduzir/enviar para a GPU, senão o quati apareceria sem textura por um instante.
function waitForTextures(root, timeoutMs = 10000) {
    const pending = [];
    const seenTex = new Set();
    root.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
            if (!m) return;
            TEXTURE_KEYS.forEach((key) => {
                const tex = m[key];
                const img = tex && tex.image;
                if (!tex || seenTex.has(tex) || !img) return;
                seenTex.add(tex);
                if (img.complete === false) {
                    pending.push(new Promise((resolve) => {
                        img.addEventListener('load', resolve, { once: true });
                        img.addEventListener('error', resolve, { once: true });
                    }));
                }
            });
        });
    });
    if (!pending.length) return Promise.resolve();
    return Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
}

// O FBX costuma vir com MeshPhongMaterial (brilhante demais). Convertemos para
// MeshStandardMaterial, mantendo cor, textura de cor e normal map.
function convertMaterials(root) {
    const cache = new Map();
    const convert = (m) => {
        if (!m) return FALLBACK_MATERIAL;
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return m;
        if (cache.has(m)) return cache.get(m);
        const std = new THREE.MeshStandardMaterial({
            name: m.name,
            color: m.color ? m.color.clone() : 0xffffff,
            map: m.map || null,
            normalMap: m.normalMap || null,
            bumpMap: m.bumpMap || null,
            aoMap: m.aoMap || null,
            emissive: m.emissive ? m.emissive.clone() : 0x000000,
            emissiveMap: m.emissiveMap || null,
            transparent: m.transparent,
            opacity: m.opacity,
            alphaTest: m.alphaTest,
            side: m.side,
            metalness: 0.05,
            roughness: 0.85
        });
        if (m.normalScale) std.normalScale.copy(m.normalScale);
        cache.set(m, std);
        return std;
    };
    root.traverse((child) => {
        if (!child.isMesh) return;
        child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
    });
}

loader.load(
    MODEL_URL,
    async (object) => {
        try {
            convertMaterials(object);
            await waitForTextures(object);
            optimizeModel(object);

            // Centraliza o quati: mede a caixa delimitadora do objeto recém
            // carregado e desloca o próprio objeto para que seu centro fique
            // em (0,0,0). O FBX costuma vir em centímetros (muito grande), mas
            // todo o resto do código se adapta ao tamanho medido aqui.
            const box = new THREE.Box3().setFromObject(object);
            const center = new THREE.Vector3();
            box.getCenter(center);
            object.position.sub(center);

            modelSize = new THREE.Vector3();
            box.getSize(modelSize);
            modelMaxDim = Math.max(modelSize.x, modelSize.y, modelSize.z) || 1;

            // O objeto centralizado vira filho de um wrapper — é esse wrapper
            // que manipulamos (posição/escala/rotação) daqui pra frente.
            modelObject = new THREE.Group();
            modelObject.add(object);

            previewMesh = modelObject;
            scene.add(previewMesh);
            scene.add(makeContactShadow());
            frameModel();

            // Compila shaders e envia geometria/texturas para a GPU AGORA, enquanto
            // ainda mostramos "Carregando", em vez de travar no primeiro frame.
            renderer.compile(scene, camera);
            warmUpTextures(object);

            hideLoading();
            checkARSupport();

            // Pré-carrega o MindAR e o arquivo do alvo quando o navegador estiver ocioso
            whenIdle(() => {
                loadMindAR().catch(() => {});
                fetch(AR_TARGET_MIND_URL).catch(() => {});
            });
        } catch (err) {
            console.error('Erro ao processar o modelo:', err);
            if (loadingEl) loadingEl.classList.add('error');
            if (loadingTextEl) loadingTextEl.textContent = 'Erro ao processar o modelo quati.fbx: ' + describeError(err);
        }
    },
    (xhr) => {
        if (xhr.total) {
            const ratio = Math.min(1, xhr.loaded / xhr.total);
            if (loadingTextEl) loadingTextEl.textContent = `Carregando modelo… ${Math.round(ratio * 100)}%`;
            if (loadingBarEl) loadingBarEl.style.transform = `scaleX(${ratio})`;
        } else if (loadingTextEl) {
            loadingTextEl.textContent = `Carregando modelo… ${(xhr.loaded / 1048576).toFixed(1)} MB`;
        }
    },
    (error) => {
        console.error('Erro ao carregar o modelo:', error);
        if (loadingEl) loadingEl.classList.add('error');
        if (loadingTextEl) {
            loadingTextEl.textContent = 'Não foi possível carregar quati.fbx. Verifique se o arquivo está na mesma pasta do index.html.';
        }
    }
);

// ==========================================================================
// ---------- Realidade Aumentada (MindAR, rastreamento de imagem) ----------
// ==========================================================================
let arActive = false;
let mindar = null;       // instância do MindARThree
let arAnchor = null;     // âncora presa à imagem-alvo
let arFollow = null;     // grupo que SEGUE a âncora de forma suavizada
let arFollowReady = false; // false até a 1ª leitura da pose (aí ele "pula" direto para a posição)
let arLostFor = 0;       // há quantos segundos a âncora está sem ser rastreada
let arMesh = null;       // wrapper do quati dentro da RA (guardado para a rotação automática)
let arContainer3D = null; // div onde o MindAR coloca vídeo + canvas

function showWarning(msg) {
    if (!arWarning) return;
    arWarning.style.display = 'block';
    arWarning.textContent = msg;
}

function describeError(e) {
    if (!e) return 'erro desconhecido';
    return `${e.name || 'Error'}: ${e.message || e}`;
}

// Verificação de suporte em etapas, cada uma com uma mensagem ESPECÍFICA -
// evita deixar o usuário travado numa tela de carregamento sem saber por quê.
async function checkARSupport() {
    if (!window.isSecureContext) {
        showWarning(
            `A RA por câmera precisa de um contexto seguro (HTTPS ou localhost). Esta página ` +
            `foi carregada via "${location.protocol}//${location.host}", que não é seguro. ` +
            `Sirva os arquivos com HTTPS (ex.: um túnel como ngrok/Cloudflare Tunnel, ou ` +
            `hospedagem com certificado válido).`
        );
        return;
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        showWarning(
            'Este navegador não expõe acesso à câmera (getUserMedia indisponível). Tente um ' +
            'navegador atualizado, como Chrome, Safari ou Firefox.'
        );
        return;
    }

    createARButton();
}

function createARButton() {
    const button = document.createElement('button');
    button.id = 'ar-button';
    button.textContent = 'Ver em RA';
    arContainer.appendChild(button);

    const hint = document.createElement('a');
    hint.id = 'ar-marker-link';
    hint.href = AR_TARGET_IMAGE_URL;
    hint.target = '_blank';
    hint.rel = 'noopener';
    hint.textContent = 'Ver foto da maquete (imprima ou abra em outra tela)';
    arContainer.appendChild(hint);

    arContainer.classList.add('ready');

    button.addEventListener('click', () => {
        if (arActive) {
            stopARSession(button);
        } else {
            startARSession(button);
        }
    });
}

async function startARSession(button) {
    if (!modelObject) {
        showWarning('O modelo 3D ainda está carregando. Aguarde um instante e tente de novo.');
        return;
    }
    button.disabled = true;
    button.textContent = 'Iniciando câmera...';
    if (arWarning) arWarning.style.display = 'none';

    try {
        let MindARThree;
        try {
            ({ MindARThree } = await loadMindAR()); // já vem do cache se o pré-carregamento terminou
        } catch (e) {
            throw new Error('não foi possível baixar a biblioteca MindAR (verifique a internet). ' + describeError(e));
        }
        setupARScene(MindARThree);
        await mindar.start(); // pede a câmera, carrega o targets.mind e inicia o rastreamento
    } catch (err) {
        console.error('Falha ao iniciar a RA:', err);
        const msg = 'Não foi possível iniciar a RA: ' + describeError(err);
        if (infoEl) infoEl.textContent = msg;
        showWarning(msg);
        teardownAR();
        button.disabled = false;
        button.textContent = 'Ver em RA';
        return;
    }

    arActive = true;
    button.disabled = false;
    button.textContent = 'Sair da RA';

    // Modo "de mesa" some enquanto a RA está ativa
    renderer.domElement.style.display = 'none';
    controls.enabled = false;
    if (infoEl) infoEl.textContent = AR_INFO_TEXT;
}

function stopARSession(button) {
    arActive = false;
    const btn = button || document.getElementById('ar-button');
    if (btn) btn.textContent = 'Ver em RA';

    teardownAR();

    renderer.domElement.style.display = 'block';
    controls.enabled = true;
    if (infoEl) infoEl.textContent = DEFAULT_INFO_TEXT;
}

// Para a câmera (apaga o LED) e descarta tudo para a próxima sessão começar limpa.
function teardownAR() {
    if (mindar) {
        try { mindar.stop(); } catch (e) { console.warn(e); }
        try { mindar.renderer.dispose(); } catch (e) { /* ignora */ }
    }
    if (arContainer3D) {
        arContainer3D.querySelectorAll('video').forEach((v) => {
            const stream = v.srcObject;
            if (stream) stream.getTracks().forEach((t) => t.stop());
        });
        arContainer3D.remove();
    }
    mindar = null;
    arAnchor = null;
    arFollow = null;
    arFollowReady = false;
    arLostFor = 0;
    arMesh = null;
    arContainer3D = null;
}

function setupARScene(MindARThree) {
    // Contêiner onde o MindAR coloca o vídeo da câmera e o canvas 3D.
    // z-index 1: fica abaixo dos botões (que usam z-index 10+).
    arContainer3D = document.createElement('div');
    arContainer3D.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;background:#000;';
    document.body.appendChild(arContainer3D);

    mindar = new MindARThree({
        container: arContainer3D,
        imageTargetSrc: AR_TARGET_MIND_URL,
        maxTrack: 1,
        filterMinCF: AR_FILTER_MIN_CF,
        filterBeta: AR_FILTER_BETA,
        warmupTolerance: AR_WARMUP_TOLERANCE,
        missTolerance: AR_MISS_TOLERANCE,            // só uma imagem-alvo: menos processamento por frame
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no'
    });

    mindar.renderer.setPixelRatio(Math.min(window.devicePixelRatio, AR_PIXEL_RATIO));

    const { scene: arScene } = mindar;
    arScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const arDirLight = new THREE.DirectionalLight(0xffffff, 1);
    arDirLight.position.set(1, 1, 1);
    arScene.add(arDirLight);

    // O quati fica dentro de arAnchor.group; o MindAR atualiza a posição desse
    // grupo a cada frame para acompanhar a imagem-alvo.
    arAnchor = mindar.addAnchor(0);

    if (modelObject) {
        // No MindAR a imagem fica no plano XY e o "para cima" é o eixo Z
        // (diferente do AR.js/Hiro, onde era o Y). Por isso o quati entra num
        // grupo "em pé" girado 90° em X; a rotação automática continua sendo
        // aplicada só no arMesh, dentro desse grupo.
        const upright = new THREE.Group();
        upright.rotation.x = Math.PI / 2;
        // arFollow fica direto na cena (não dentro de arAnchor.group): a cada
        // quadro ele é movido suavemente até a pose da âncora (ver updateARFollow).
        arFollow = new THREE.Group();
        arFollow.visible = false;
        arFollow.add(upright);
        arScene.add(arFollow);

        arMesh = modelObject.clone(true);
        const scale = CAPY_SCALE / modelMaxDim;
        arMesh.scale.setScalar(scale);
        arMesh.rotation.y = CAPY_HEADING;

        // Posição na maquete: o MindAR usa o CENTRO da imagem como origem, com a
        // largura valendo 1 e o eixo Y para cima. Converte pixels da foto -> essas unidades.
        const aspect = AR_TARGET_PX_H / AR_TARGET_PX_W;
        upright.position.set(
            (CAPY_PX.x / AR_TARGET_PX_W - 0.5),
            (0.5 - CAPY_PX.y / AR_TARGET_PX_H) * aspect,
            0
        );

        // Eixo vertical: apoiar o quati sobre a imagem (ver INVERT_MODEL_Y no topo).
        const verticalOffset = (modelSize.y / 2) * scale;
        arMesh.position.y = INVERT_MODEL_Y ? -verticalOffset : verticalOffset;

        upright.add(arMesh);
    }

    prewarmARRenderer(arScene);

    // Avisos quando a imagem-alvo é encontrada / perdida
    // (a decisão de "posicionar direto" ou "deslizar" é feita em updateARFollow)
    arAnchor.onTargetFound = () => {
        if (infoEl) infoEl.textContent = 'Imagem encontrada!';
    };
    arAnchor.onTargetLost = () => {
        if (infoEl) infoEl.textContent = AR_INFO_TEXT;
    };
}

// ---------- Pré-aquecimento do renderer da RA ----------
// A RA usa um renderer PRÓPRIO (do MindAR), com outro contexto WebGL. Sem isto, os
// shaders, a geometria e as 3 texturas só iriam para a GPU no instante em que a
// imagem fosse reconhecida pela primeira vez — e era aí que acontecia a travada.
// Aqui tudo isso é feito antes da câmera ligar, desenhando 1 quadro minúsculo
// e invisível (escala ~0, no ponto da câmera).
function prewarmARRenderer(arScene) {
    if (!mindar || !arFollow || !arMesh) return;
    const rend = mindar.renderer;
    const meshes = [];
    arMesh.traverse((o) => { if (o.isMesh) { meshes.push([o, o.frustumCulled]); o.frustumCulled = false; } });
    try {
        arFollow.visible = true;            // compile()/render() só enxergam objetos visíveis
        arFollow.scale.setScalar(1e-6);
        arScene.updateMatrixWorld(true);
        rend.compile(arScene, mindar.camera);
        warmUpTextures(arMesh, rend);
        rend.render(arScene, mindar.camera); // sobe geometria + buffers
    } catch (e) {
        console.warn('Pré-aquecimento da RA falhou (não é crítico):', e);
    } finally {
        meshes.forEach(([o, v]) => { o.frustumCulled = v; });
        arFollow.scale.setScalar(1);
        arFollow.visible = false;
        arFollowReady = false;
    }
}

// ---------- Loop de renderização ----------
const _tp = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _ts = new THREE.Vector3();

// Move arFollow suavemente em direção à pose atual da âncora do MindAR.
function updateARFollow(delta) {
    if (!arAnchor || !arFollow) return;
    if (!arAnchor.group.visible) {
        // Rastreamento perdeu a imagem: mantém o quati na última pose por um
        // instante (ela continua girando) e só então esconde.
        arLostFor += delta;
        if (arLostFor > AR_HOLD_SECONDS) {
            arFollow.visible = false;
            arFollowReady = false; // ao reencontrar depois disso, posiciona direto
        }
        return;
    }
    arLostFor = 0;
    arAnchor.group.matrix.decompose(_tp, _tq, _ts);
    if (!arFollowReady) {
        arFollow.position.copy(_tp);
        arFollow.quaternion.copy(_tq);
        arFollow.scale.copy(_ts);
        arFollowReady = true;
    } else {
        // Fator exponencial: resultado igual em 30, 60 ou 120 fps
        const a = 1 - Math.exp(-AR_SMOOTHING * delta);
        arFollow.position.lerp(_tp, a);
        arFollow.quaternion.slerp(_tq, a);
        arFollow.scale.lerp(_ts, a);
    }
    arFollow.visible = true;
}

function animate() {
    requestAnimationFrame(animate);
    // Limita o delta: depois de uma pausa (aba em segundo plano, carregamento
    // pesado) o modelo não dá um "salto" de rotação.
    const delta = Math.min(clock.getDelta(), 0.1);
    if (document.hidden) return; // aba escondida: não gasta GPU

    // ---------- MOVIMENTO: rotação automática do modelo ----------
    // Gira o mesh que está visível no momento (o de mesa ou o da RA) no
    // eixo configurado em MODEL_ROTATION_AXIS, lá no topo do arquivo. Fica
    // independente do arraste manual do OrbitControls, que continua
    // funcionando normalmente por cima disso no modo "de mesa".
    // Enquanto o usuário arrasta, a rotação desacelera até parar; ao soltar,
    // volta acelerando de forma suave (em vez de dar um tranco).
    const spinTarget = (arActive || !userInteracting) ? 1 : 0;
    spinFactor += (spinTarget - spinFactor) * (1 - Math.exp(-5 * delta));

    if (MODEL_AUTO_ROTATE) {
        const activeMesh = arActive ? (AR_AUTO_ROTATE ? arMesh : null) : previewMesh;
        if (activeMesh) {
            activeMesh.rotation[MODEL_ROTATION_AXIS] += MODEL_ROTATION_SPEED * delta * spinFactor;
        }
    }

    if (arActive) {
        // O rastreamento roda dentro do MindAR; aqui só desenhamos a cena.
        updateARFollow(delta);
        if (mindar) mindar.renderer.render(mindar.scene, mindar.camera);
    } else {
        adaptQuality(delta);
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();

// ---------- Responsividade (modo "de mesa") ----------
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        if (!userMovedCamera) frameModel(); // girou o celular? reenquadra o quati
    }, 100);
});

// ==========================================================================
// ---------- QR Code de acesso rápido ----------
// ==========================================================================
let qrRendered = false;

// A biblioteca de QR Code só é baixada quando o painel é aberto pela primeira vez.
const QR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
let qrLibPromise = null;
function loadQRLib() {
    if (typeof QRCode !== 'undefined') return Promise.resolve();
    if (!qrLibPromise) {
        qrLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = QR_LIB_URL;
            s.onload = resolve;
            s.onerror = () => { qrLibPromise = null; reject(new Error('QRCode')); };
            document.head.appendChild(s);
        });
    }
    return qrLibPromise;
}

async function renderQRCode() {
    const target = document.getElementById('qrcode');
    if (!target) return;
    const urlEl = document.getElementById('qr-url');
    if (urlEl) urlEl.textContent = window.location.href; // o endereço aparece mesmo se o QR falhar
    try {
        await loadQRLib();
    } catch (e) {
        return;
    }
    target.innerHTML = '';
    new QRCode(target, {
        text: window.location.href,
        width: 180,
        height: 180,
        colorDark: '#1d3a2d',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    qrRendered = true;
}

const qrToggle = document.getElementById('qr-toggle');
const qrPanel = document.getElementById('qr-panel');
if (qrToggle && qrPanel) {
    qrToggle.addEventListener('click', () => {
        const isOpen = qrPanel.classList.toggle('open');
        if (isOpen && !qrRendered) renderQRCode();
    });
    const closeQR = () => qrPanel.classList.remove('open');
    const qrClose = document.getElementById('qr-close');
    if (qrClose) qrClose.addEventListener('click', closeQR);
    qrPanel.addEventListener('click', (e) => { if (e.target === qrPanel) closeQR(); }); // clique fora fecha
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQR(); });
}
