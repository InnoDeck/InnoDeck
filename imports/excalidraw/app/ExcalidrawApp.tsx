import React, { useCallback } from 'react'
import polyfill from '/imports/utils/polyfill'
import { useEffect, useRef, useState } from 'react'
import { trackEvent } from '../analytics'
import { getDefaultAppState } from '../appState'
import { ErrorDialog } from '../components/ErrorDialog'
import { APP_NAME, EVENT, THEME, TITLE_TIMEOUT, VERSION_TIMEOUT } from '../constants'
import { loadFromBlob } from '../data/blob'
import { ExcalidrawElement, FileId, NonDeletedExcalidrawElement, Theme } from '../element/types'
import { useCallbackRefState } from '../hooks/useCallbackRefState'
import { t } from '/imports/i18n'
import { Excalidraw, defaultLang } from './ExcalidrawBase'
import {
  AppState,
  LibraryItems,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState
} from '../types'
import {
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  ResolvablePromise,
  resolvablePromise
} from '../utils'
import {
  FIREBASE_STORAGE_PREFIXES,
  SAVE_TO_CLOUD_STORAGE_TIMEOUT,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT
} from './app_constants'
import {
  CollabClass,
  CollabAPI,
  collabAPIAtom,
  collabDialogShownAtom,
  isCollaboratingAtom
} from './collab/Collab'
import { exportToBackend, getCollaborationLinkData, isCollaborationLink, loadScene } from './data'
import {
  getLibraryItemsFromStorage,
  importFromLocalStorage,
  importUsernameFromLocalStorage
} from './data/localStorage'
import CustomStats from './CustomStats'
import { restore, restoreAppState, RestoredDataState } from '../data/restore'

import './ExcalidrawApp.style.scss'

import { updateStaleImageStatuses } from './data/FileManager'
import { newElementWith } from '../element/mutateElement'
import { isInitializedImageElement } from '../element/typeChecks'
import { loadFilesFromFirebase } from './data/firebase'
import { LocalData } from './data/LocalData'
import { isBrowserStorageStateNewer } from './data/tabSync'
import clsx from 'clsx'
import { atom, useAtom } from 'jotai'
import { useAtomWithInitialValue } from '../../store/jotai'
import { reconcileElements } from './collab/reconciliation'
import { parseLibraryTokensFromUrl, useHandleLibrary } from '../data/library'
import { attachDebugLabel, useStore } from '/imports/store'
import { updateBoard } from '/imports/services/client'
import { Services } from '/imports/services/client'

polyfill()
window.EXCALIDRAW_THROTTLE_RENDER = true

const initializeScene = async (opts: {
  collabAPI: CollabAPI
  excalidrawAPI: ExcalidrawImperativeAPI
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const searchParams = new URLSearchParams(window.location.search)
  const id = searchParams.get('id')
  const jsonBackendMatch = window.location.hash.match(/^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/)
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/)

  // Load board data from cloud
  const boardId = getCurrentBoardId()
  const boardFromCloud = await Services.get('board').getBoardById(boardId)

  const localDataState = importFromLocalStorage()

  let scene: RestoredDataState & {
    scrollToContent?: boolean
  } = await loadScene(null, null, Object.assign(localDataState, boardFromCloud))

  let roomLinkData = getCollaborationLinkData(window.location.href)
  const isExternalScene = !!(id || jsonBackendMatch || roomLinkData)
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      window.confirm(t('alerts.loadSceneOverridePrompt'))
    ) {
      if (jsonBackendMatch) {
        scene = await loadScene(jsonBackendMatch[1], jsonBackendMatch[2], localDataState)
      }
      scene.scrollToContent = true
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin)
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            'focus',
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true
            }
          )
        })
      }

      roomLinkData = null
      window.history.replaceState({}, APP_NAME, window.location.origin)
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin)

    const url = externalUrlMatch[1]
    try {
      const request = await fetch(window.decodeURIComponent(url))
      const data = await loadFromBlob(await request.blob(), null, null)
      if (!scene.elements.length || window.confirm(t('alerts.loadSceneOverridePrompt'))) {
        return { scene: data, isExternalScene }
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t('alerts.invalidSceneUrl')
          }
        },
        isExternalScene
      }
    }
  }

  if (roomLinkData) {
    const { excalidrawAPI } = opts

    const scene = await opts.collabAPI.startCollaboration(roomLinkData)

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(
            {
              ...scene?.appState,
              theme: localDataState?.appState?.theme || scene?.appState?.theme
            },
            excalidrawAPI.getAppState()
          ),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState()
        )
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey
    }
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2]
        }
      : { scene, isExternalScene: false }
  }
  return { scene: null, isExternalScene: false }
}

const currentLangCode = defaultLang.code

export const langCodeAtom = attachDebugLabel(
  atom(Array.isArray(currentLangCode) ? currentLangCode[0] : currentLangCode),
  'langCodeAtom'
)

const ExcalidrawWrapper = () => {
  const [errorMessage, setErrorMessage] = useState('')
  const [langCode, setLangCode] = useAtom(langCodeAtom)

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>
  }>({ promise: null! })
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise = resolvablePromise<ExcalidrawInitialDataState | null>()
  }

  useEffect(() => {
    trackEvent('load', 'frame', getFrame())
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent('load', 'version', getVersion())
    }, VERSION_TIMEOUT)
  }, [])

  const [excalidrawAPI, excalidrawRefCallback] = useCallbackRefState<ExcalidrawImperativeAPI>()

  const [collabAPI] = useAtom(collabAPIAtom)
  const [, setCollabDialogShown] = useAtom(collabDialogShownAtom)
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href)
  })

  useHandleLibrary({
    excalidrawAPI,
    getInitialLibraryItems: getLibraryItemsFromStorage
  })

  const isExcalidrawAPIAvailable = !!excalidrawAPI
  useEffect(() => {
    if (isExcalidrawAPIAvailable) {
      const collab = new CollabClass(excalidrawAPI)
      collab.mount()
      return () => collab.unmount()
    }
  }, [isExcalidrawAPIAvailable])

  useEffect(() => {
    if (!collabAPI || !excalidrawAPI) {
      return
    }

    const loadImages = (data: ResolutionType<typeof initializeScene>, isInitialLoad = false) => {
      if (!data.scene) {
        return
      }
      if (collabAPI.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
              forceFetchFiles: true
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles)
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted()
              })
            })
        }
      } else {
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId)
            }
            return acc
          }, [] as FileId[]) || []

        if (data.isExternalScene) {
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles)
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted()
            })
          })
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage.getFiles(fileIds).then(({ loadedFiles, erroredFiles }) => {
              if (loadedFiles.length) {
                excalidrawAPI.addFiles(loadedFiles)
              }
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted()
              })
            })
          }
          // on fresh load, clear unused files from IDB (from previous
          // session)
          LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds })
        }
      }
    }

    initializeScene({ collabAPI, excalidrawAPI }).then(async data => {
      loadImages(data, /* isInitialLoad */ true)
      initialStatePromiseRef.current.promise.resolve(data.scene)
    })

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault()
      const libraryUrlTokens = parseLibraryTokensFromUrl()
      if (!libraryUrlTokens) {
        if (collabAPI.isCollaborating() && !isCollaborationLink(window.location.href)) {
          collabAPI.stopCollaboration(false)
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } })

        initializeScene({ collabAPI, excalidrawAPI }).then(data => {
          loadImages(data)
          if (data.scene) {
            excalidrawAPI.updateScene({
              ...data.scene,
              ...restore(data.scene, null, null),
              commitToHistory: true
            })
          }
        })
      }
    }

    const titleTimeout = setTimeout(() => (document.title = APP_NAME), TITLE_TIMEOUT)

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return
      }
      if (!document.hidden && !collabAPI.isCollaborating()) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage()
          const username = importUsernameFromLocalStorage()
          setLangCode(currentLangCode)
          excalidrawAPI.updateScene({
            ...localDataState
          })
          excalidrawAPI.updateLibrary({
            libraryItems: getLibraryItemsFromStorage()
          })
          // TODO use Meteor.user().username
          // collabAPI.setUsername(username || '')
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
          const currFiles = excalidrawAPI.getFiles()
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId)
              }
              return acc
            }, [] as FileId[]) || []
          if (fileIds.length) {
            LocalData.fileStorage.getFiles(fileIds).then(({ loadedFiles, erroredFiles }) => {
              if (loadedFiles.length) {
                excalidrawAPI.addFiles(loadedFiles)
              }
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted()
              })
            })
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT)

    const onUnload = () => {
      LocalData.flushSave()
    }

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave()
      }
      if (event.type === EVENT.VISIBILITY_CHANGE || event.type === EVENT.FOCUS) {
        syncData()
      }
    }

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false)
    window.addEventListener(EVENT.UNLOAD, onUnload, false)
    window.addEventListener(EVENT.BLUR, visibilityChange, false)
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false)
    window.addEventListener(EVENT.FOCUS, visibilityChange, false)
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false)
      window.removeEventListener(EVENT.UNLOAD, onUnload, false)
      window.removeEventListener(EVENT.BLUR, visibilityChange, false)
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false)
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false)
      clearTimeout(titleTimeout)
    }
  }, [collabAPI, excalidrawAPI, setLangCode])

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave()

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(excalidrawAPI.getSceneElements())
      ) {
        preventUnload(event)
      }
    }
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler)
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler)
    }
  }, [excalidrawAPI])

  const [theme, setTheme] = useState<Theme>(
    () =>
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME) ||
      // FIXME migration from old LS scheme. Can be removed later. #5660
      importFromLocalStorage().appState?.theme ||
      THEME.LIGHT
  )

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, theme)
    // currently only used for body styling during init (see public/index.html),
    // but may change in the future
    document.documentElement.classList.toggle('dark', theme === THEME.DARK)
  }, [theme])

  const onChange = async (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements)
    }

    setTheme(appState.theme)

    // sync board to cloud
    saveBoardToCloud(files, elements, appState)

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false

          const elements = excalidrawAPI.getSceneElementsIncludingDeleted().map(element => {
            if (LocalData.fileStorage.shouldUpdateImageElementStatus(element)) {
              const newElement = newElementWith(element, { status: 'saved' })
              if (newElement !== element) {
                didChange = true
              }
              return newElement
            }
            return element
          })

          if (didChange) {
            excalidrawAPI.updateScene({
              elements
            })
          }
        }
      })
    }
  }

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    canvas: HTMLCanvasElement | null
  ) => {
    if (exportedElements.length === 0) {
      return window.alert(t('alerts.cannotExportEmptyCanvas'))
    }
    if (canvas) {
      try {
        await exportToBackend(
          exportedElements,
          {
            ...appState,
            viewBackgroundColor: appState.exportBackground
              ? appState.viewBackgroundColor
              : getDefaultAppState().viewBackgroundColor
          },
          files
        )
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          const { width, height } = canvas
          console.error(error, { width, height })
          setErrorMessage(error.message)
        }
      }
    }
  }

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: AppState
  ) => {
    return (
      <CustomStats
        setToast={message => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    )
  }

  const onLibraryChange = async (items: LibraryItems) => {
    if (!items.length) {
      localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY)
      return
    }
    const serializedItems = JSON.stringify(items)
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY, serializedItems)
  }

  return (
    <div
      style={{ height: '100%' }}
      className={clsx('excalidraw-app', {
        'is-collaborating': isCollaborating
      })}
    >
      <Excalidraw
        ref={excalidrawRefCallback}
        onChange={useCallback(onChange, [excalidrawAPI, collabAPI])}
        initialData={initialStatePromiseRef.current.promise}
        onCollabButtonClick={useCallback(() => setCollabDialogShown(true), [])}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: { onExportToBackend }
          }
        }}
        langCode={langCode}
        renderCustomStats={useCallback(renderCustomStats, [])}
        detectScroll={false}
        handleKeyboardGlobally={true}
        onLibraryChange={useCallback(onLibraryChange, [])}
        autoFocus={true}
        theme={theme}
        gridModeEnabled={false}
      />
      {errorMessage && <ErrorDialog message={errorMessage} onClose={() => setErrorMessage('')} />}
    </div>
  )
}

export function ExcalidrawApp() {
  return <ExcalidrawWrapper />
}

export function getCurrentBoardId() {
  const { currentBoardId } = useStore.getState().appState
  const boardIdFromPath = location.href.split('/board/').pop() ?? ''

  return currentBoardId.length > 0 ? currentBoardId : boardIdFromPath
}

export const saveBoardToCloud = debounce(async function (
  files: BinaryFiles,
  elements,
  appState: AppState
) {
  const ret = await updateBoard(
    {
      id: getCurrentBoardId(),
      title: '',
      files,
      elements
    },
    appState
  )
  console.log('[SaveBoardToMongoDB] success:', ret)
  return ret
},
SAVE_TO_CLOUD_STORAGE_TIMEOUT)
