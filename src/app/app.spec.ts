import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render the title and all tabs', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Website Testing Agent');
    const tabs = [...compiled.querySelectorAll('[role=tab]')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Chat', 'Test Plan', 'Code', 'Screenshots', 'Page Model', 'Metrics', 'Settings']);
  });

  it('should report that the agent backend is unavailable without a bridge', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.notice')?.textContent).toContain('backend unavailable');
  });

  it('should render the live view column', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-live-view')).toBeTruthy();
  });

  it('should show the token counter at zero', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const counter = (fixture.nativeElement as HTMLElement).querySelector('.counter');
    expect(counter?.textContent?.replace(/\s+/g, '')).toBe('0tokens·0calls');
  });

  it('should switch to the screenshots tab', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    (compiled.querySelectorAll('[role=tab]')[3] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(compiled.querySelector('app-screenshots-panel')).toBeTruthy();
  });
});
