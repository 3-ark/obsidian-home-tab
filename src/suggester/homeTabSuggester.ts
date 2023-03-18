import type Fuse from 'fuse.js'
import { normalizePath, Platform, TAbstractFile, TFile, View, type App } from 'obsidian'
import { DEFAULT_FUSE_OPTIONS, FileFuzzySearch, type SearchFile } from './fuzzySearch'
import type HomeTab from '../main'
import type { HomeTabSearchBar } from 'src/homeView'
import { generateSearchFile,  getParentFolderFromPath,  getSearchFiles, getUnresolvedMarkdownFiles } from 'src/utils/getFilesUtils'
import { TextInputSuggester } from './suggester'
import { addLucideIcon } from 'src/utils/htmlUtils'
import { generateHotkeySuggestion } from 'src/utils/htmlUtils'
import { isValidExtension, isValidFileType, type FileExtension, type FileType } from 'src/utils/getFileTypeUtils'
import { get } from 'svelte/store'

declare module 'obsidian'{
    interface MetadataCache{
        onCleanCache: Function
    }
}

export default class HomeTabFileSuggester extends TextInputSuggester<Fuse.FuseResult<SearchFile>>{
    private files: SearchFile[]
    private fuzzySearch: FileFuzzySearch

    private view: View
    private plugin: HomeTab
    private searchBar: HomeTabSearchBar

    private activeExt: FileType | FileExtension | null
    private activeExtEl: HTMLElement

    constructor(app: App, plugin: HomeTab, view: View, searchBar: HomeTabSearchBar) {
        super(app, get(searchBar.searchBarEl), get(searchBar.suggestionContainerEl), {
                // @ts-ignore
                containerClass: `home-tab-suggestion-container ${Platform.isPhone ? 'is-phone' : ''}`,
                // suggestionClass: 'home-tab-suggestion', 
                suggestionItemClass: 'suggestion-item mod-complex',
                additionalClasses: `${plugin.settings.selectionHighlight === 'accentColor' ? 'use-accent-color' : ''}`,
                additionalModalInfo: plugin.settings.showShortcuts ? generateHotkeySuggestion([
                    {hotkey: '↑↓', action: 'to navigate'},
                    {hotkey: '↵', action: 'to open'},
                    {hotkey: 'shift ↵', action: 'to create'},
                    {hotkey: 'ctrl ↵', action: 'to open in new tab'},
                    {hotkey: 'esc', action: 'to dismiss'},], 
                    'home-tab-hotkey-suggestions') : undefined
                }, plugin.settings.searchDelay)
        this.plugin = plugin
        this.view = view
        this.searchBar = searchBar
        this.searchBar.activeExtEl.subscribe(element => this.activeExtEl = element)

        this.app.metadataCache.onCleanCache(() => {
            this.plugin.settings.markdownOnly ? this.files = this.filterSearchFileArray('markdown', getSearchFiles(this.plugin.settings.unresolvedLinks)) : this.files = getSearchFiles(this.plugin.settings.unresolvedLinks)
            this.fuzzySearch = new FileFuzzySearch(this.files, { ...DEFAULT_FUSE_OPTIONS, ignoreLocation: true, fieldNormWeight: 1.65, keys: [{name: 'basename', weight: 1.5}, {name: 'aliases', weight: 0.1}] })
        })

        // Open file in new tab
        this.scope.register(['Mod'], 'Enter', (e) => {
            e.preventDefault()
            this.useSelectedItem(this.suggester.getSelectedItem(), true)
        })
        // Create file
        this.scope.register(['Shift'], 'Enter', async(e) => {
            e.preventDefault()
            await this.handleFileCreation()
        })
        // Create file and open in new tab
        this.scope.register(['Shift', 'Mod'], 'Enter', async(e) => {
            e.preventDefault()
            await this.handleFileCreation(undefined, true)
        })

        this.inputEl.addEventListener('keydown', (e) => {
            // if(this.plugin.settings.markdownOnly) return
            // If the input field is empty and an active filter is active remove it
            if(e.key === 'Backspace'){
                const inputValue = this.inputEl.value
                if(inputValue != '') return
                if(this.activeExt){
                    this.activeExt = null
                    this.fuzzySearch.updateSearchArray(this.files)
                    this.activeExtEl.toggleClass('hide', true)
                }
            }

            if(e.key === 'Tab'){
                e.preventDefault()
                // Activate search filter with tab
                const inputValue = this.inputEl.value as FileType | FileExtension
                if (isValidExtension(inputValue) || isValidFileType(inputValue)){
                    this.activeExtEl.setText(inputValue)
                    this.activeExtEl.toggleClass('hide', false)
                    this.activeExt = inputValue
                    
                    this.app.metadataCache.onCleanCache(() => {
                        this.fuzzySearch.updateSearchArray(this.filterSearchFileArray(inputValue, this.plugin.settings.markdownOnly ? getSearchFiles(this.plugin.settings.unresolvedLinks) : this.files))
                    })
                    
                    this.inputEl.value = ''
                    this.suggester.setSuggestions([]) // Reset search suggestions
                    this.close()
                }
            }
        })

        this.view.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => { if(file instanceof TFile){this.updateSearchfilesList(file)}}))
        this.view.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => { if(file instanceof TFile){this.updateSearchfilesList(file)}}))
        this.view.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => { if(file instanceof TFile){this.updateSearchfilesList(file, oldPath)}}))
        this.view.registerEvent(this.app.metadataCache.on('resolved', () => this.updateUnresolvedFiles()))
    }

    updateSearchBarContainerEl(isActive: boolean){
        this.inputEl.parentElement?.toggleClass('is-active', isActive)
    }

    onOpen(): void {
        this.updateSearchBarContainerEl(this.suggester.getSuggestions().length > 0 ? true : false)    
    }

    onClose(): void {
        this.updateSearchBarContainerEl(false)
    }

    filterSearchFileArray(filterKey: FileType | FileExtension, fileArray: SearchFile[]): SearchFile[]{
        const arrayToFilter = fileArray
        return arrayToFilter.filter(file => isValidExtension(filterKey) ? file.extension === filterKey : file.fileType === filterKey)
    }

    updateUnresolvedFiles(){
        const unresolvedFiles = getUnresolvedMarkdownFiles()
        let newFiles = false
        unresolvedFiles.forEach((unresolvedFile) => {
            if(!this.files.includes(unresolvedFile)){
                this.files.push(unresolvedFile)
                newFiles = true
            }
        })
        if(newFiles) this.fuzzySearch.updateSearchArray(this.files)
    }

    updateSearchfilesList(file:TFile, oldPath?: string){
        this.app.metadataCache.onCleanCache(() => {
            if(oldPath){
                this.files.splice(this.files.findIndex((f) => f.path === oldPath),1)
                this.files.push(generateSearchFile(file))
            }
            if(file.deleted){
                this.files.splice(this.files.findIndex((f) => f.path === file.path),1)
    
                // if(isUnresolved({name: file.name, path: file.path, basename: file.basename, extension: file.extension})){
                //     this.files.push(generateMarkdownUnresolvedFile(file.path))
                // }
            }
            else{
                const fileIndex = this.files.findIndex((f) => f.path === file.path)
                if(fileIndex === -1){
                    this.files.push(generateSearchFile(file))
                }
                else if(this.files[fileIndex].isUnresolved){
                    this.files[fileIndex] = generateSearchFile(file)
                }
            }
            this.fuzzySearch.updateSearchArray(this.files)
        })
    }

    onNoSuggestion(): void {
        if(!this.activeExt || this.activeExt === 'markdown' || this.activeExt === 'md'){
            const input = this.inputEl.value
            if (!!input) {
                this.suggester.setSuggestions([{
                        item: {
                            name: `${input}.md`,
                            path: `${input}.md`,
                            basename: input,
                            isCreated: false,
                            fileType: 'markdown',
                            extension: 'md',
                        },
                        refIndex: 0,
                        score: 0,
                }])
                this.open()
            }
            else{
                this.close()
            }
        }
        else{
            this.close()
        }
    }
    
    getSuggestions(input: string): Fuse.FuseResult<SearchFile>[] {
        return this.fuzzySearch.rawSearch(input, this.plugin.settings.maxResults)
    }

    useSelectedItem(selectedItem: Fuse.FuseResult<SearchFile>, newTab?: boolean): void {
        if(selectedItem.item.isCreated && selectedItem.item.file){
            this.openFile(selectedItem.item.file, newTab)
        }
        else{
            this.handleFileCreation(selectedItem.item, newTab)
        }
    }

    generateDisplayElementContent(suggestion: Fuse.FuseResult<SearchFile>): HTMLElement[] {
        const contentEl = createDiv('suggestion-content')
        const suggestionTitleEl = contentEl.createDiv('suggestion-title home-tab-suggestion-title')
        const suggestionAuxEl = createDiv('suggestion-aux')

        // Suggestion name
        const nameToDisplay = this.fuzzySearch.getBestMatch(suggestion, this.inputEl.value)
        const fileNameEl = suggestionTitleEl.createEl('span', { text: nameToDisplay })
        if(suggestion.item.fileType != 'markdown'){
            suggestionTitleEl.createEl('div', { text: suggestion.item.extension, cls: 'nav-file-tag home-tab-suggestion-file-tag'})
        }
        
        // File details
        if (suggestion.item.isCreated) {
            // If the suggestion name is an alias display the actual filename under it
            if (suggestion.item.aliases && suggestion.item.aliases?.includes(nameToDisplay)) {
                const noteEl = contentEl.createDiv('home-tab-suggestion-description')
                addLucideIcon(noteEl, 'forward', {size: 15, ariaLabel: 'Alias of'})
                noteEl.createEl('span', { text:  suggestion.item.basename})
            }
        }
        else {
            // Show if a file is not created
            const iconContainerEl = suggestionAuxEl.createDiv('home-tab-suggestion-tip')
            if(suggestion.item.isUnresolved){
                suggestionTitleEl.addClass('is-unresolved')
                addLucideIcon(iconContainerEl, 'file-plus', {size: 15, ariaLabel: 'Not created yet, select to create'})
            }
            else{
                suggestionAuxEl.createDiv('suggestion-hotkey').createEl('span', {text: 'Enter to create'})
                addLucideIcon(iconContainerEl, 'file-question', {size: 15, ariaLabel: 'Not exists yet, select to create'})
            }
        }

        // Display file path
        if(suggestion.item.isCreated || suggestion.item.isUnresolved){
            if (this.plugin.settings.showPath) {
                const pathEl = suggestionAuxEl.createEl('div', { cls: 'home-tab-suggestion-filepath', attr: {'aria-label' : 'File path'}})
                // const pathText = suggestion.item.path.replace(suggestion.item.name, '') // Full path
                const pathText = suggestion.item.file ? suggestion.item.file.parent.name : getParentFolderFromPath(suggestion.item.path) // Parent folder
                const iconContainer = pathEl.createDiv('')
                addLucideIcon(iconContainer, 'folder', {size: 15})
                pathEl.createEl('span', { text: pathText , cls: 'home-tab-file-path'})
            }
        }

        return [contentEl, suggestionAuxEl]
    }

    async handleFileCreation(selectedFile?: SearchFile, newTab?: boolean): Promise<void>{
        let newFile: TFile
        
        if(selectedFile?.isUnresolved){
            const folderPath = selectedFile.path.replace(selectedFile.name, '')
            if(!await this.app.vault.adapter.exists(folderPath)){
                await this.app.vault.createFolder(folderPath)
            }
            newFile = await this.app.vault.create(selectedFile.path, '')
        }
        else{
            const input = this.inputEl.value;
            // If a file with the same filename exists open it
            // Mimics the behaviour of the default quick switcher
            const files = this.files.filter(file => file.fileType === 'markdown')
            if(files.map(file => file.basename).includes(input)){
                const fileToOpen = files.find(f => f.basename === input)?.file
                if(fileToOpen){
                    return this.openFile(fileToOpen, newTab)
                }
            }
            newFile = await this.app.vault.create(normalizePath(`${this.app.fileManager.getNewFileParent('').path}/${input}.md`), '')
        }
        
        
        this.openFile(newFile, newTab)
    }

    openFile(file: TFile, newTab?: boolean): void{
        if(newTab){
            this.app.workspace.createLeafInTabGroup().openFile(file)
            // this.inputEl.value = ''
        }
        else{
            this.view.leaf.openFile(file);
        }
    }
}
